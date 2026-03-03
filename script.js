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
let scatterChartInstance = null;
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
}

// ---- Recently Played + Play Logger ----
async function loadRecentlyPlayed() {
  const token = localStorage.getItem('spotify_token');
  if (!token) return;

  const data = await spotifyFetch('https://api.spotify.com/v1/me/player/recently-played?limit=50');
  if (!data || !data.items) return;

  const seenIds = new Set();
  const albums = [];
  data.items.forEach(function(item) {
    const album = item.track.album;
    if (!seenIds.has(album.id)) {
      seenIds.add(album.id);
      albums.push(album);
    }
  });

  await logPlays(data.items);

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

  const seenIds = new Set();
  const toLog = [];
  items.forEach(function(item) {
    const album = item.track.album;
    if (!seenIds.has(album.id)) {
      seenIds.add(album.id);
      toLog.push({
        spotify_album_id: album.id,
        album_name: album.name,
        artist: album.artists && album.artists[0] ? album.artists[0].name : '',
        image_url: album.images && album.images[0] ? album.images[0].url : '',
        logged_at: new Date().toISOString()
      });
    }
  });
  if (toLog.length > 0) await db.from('play_logs').insert(toLog);
}

// ---- Recommendations ----
async function loadRecommendations() {
  const token = localStorage.getItem('spotify_token');
  if (!token) return;

  // Get your highest rated albums (8+)
  const { data: topRatings } = await db
    .from('ratings')
    .select('*, albums(*)')
    .gte('rating', 8)
    .order('rating', { ascending: false })
    .limit(5);

  if (!topRatings || topRatings.length === 0) return;

  // Get all already-rated spotify IDs to filter them out
  const { data: allRated } = await db.from('albums').select('spotify_id');
  const ratedIds = new Set((allRated || []).map(function(a) { return a.spotify_id; }));

  // For each top album, get the artist, then related artists, then their 2025/2026 albums
  const recommendations = [];
  const seenRecIds = new Set();

  for (const r of topRatings) {
    try {
      const album = await spotifyFetch('https://api.spotify.com/v1/albums/' + r.albums.spotify_id);
      if (!album) continue;
      const artistId = album.artists && album.artists[0] ? album.artists[0].id : null;
      if (!artistId) continue;

      const related = await spotifyFetch('https://api.spotify.com/v1/artists/' + artistId + '/related-artists');
      if (!related || !related.artists) continue;

      // Take top 3 related artists
      for (const relArtist of related.artists.slice(0, 3)) {
        const searchUrl = 'https://api.spotify.com/v1/search?q=artist:"' +
          encodeURIComponent(relArtist.name) + '"&type=album&limit=5';
        const token = localStorage.getItem('spotify_token');
        const res = await fetch(searchUrl, { headers: { Authorization: 'Bearer ' + token } });
        if (!res.ok) continue;
        const searchData = await res.json();
        if (!searchData.albums || !searchData.albums.items) continue;

        for (const recAlbum of searchData.albums.items) {
          const year = recAlbum.release_date ? parseInt(recAlbum.release_date.substring(0, 4)) : 0;
          if (year < 2025) continue;
          if (ratedIds.has(recAlbum.id)) continue;
          if (seenRecIds.has(recAlbum.id)) continue;
          if (recAlbum.album_type !== 'album') continue;
          seenRecIds.add(recAlbum.id);
          recommendations.push(recAlbum);
          if (recommendations.length >= 12) break;
        }
        if (recommendations.length >= 12) break;
      }
      if (recommendations.length >= 12) break;
    } catch(e) {
      console.log('Rec error:', e);
    }
  }

  if (recommendations.length === 0) return;

  const section = document.getElementById('recommendations-section');
  const container = document.getElementById('recommendations-results');
  section.classList.remove('hidden');

  container.innerHTML = recommendations.map(function(album) {
    const img = album.images && album.images[0] ? album.images[0].url : '';
    const artist = album.artists && album.artists[0] ? album.artists[0].name : '';
    const year = album.release_date ? album.release_date.substring(0, 4) : '';
    return '<div class="album-card" onclick="openAlbum(\'' + album.id + '\')">' +
      '<img src="' + img + '" alt="' + album.name + '" />' +
      '<div class="album-card-info"><h3>' + album.name + '</h3><p>' + artist + '</p>' +
      '<p style="color:var(--green);font-size:0.7rem;margin-top:3px">' + year + '</p></div></div>';
  }).join('');
}

// ---- Replay Tracker ----
async function loadReplayTracker() {
  const { data: logs } = await db.from('play_logs').select('*').order('logged_at', { ascending: true });
  if (!logs || logs.length === 0) {
    document.getElementById('replayBarChart').closest('.chart-card').innerHTML +=
      '<p style="color:var(--text-muted);font-size:0.85rem;margin-top:8px">No play data yet — open the app a few times to start building your history!</p>';
    return;
  }
  renderReplayBar(logs);
  renderReplayLine(logs);
}

function renderReplayBar(logs) {
  const counts = {};
  logs.forEach(function(log) { counts[log.album_name] = (counts[log.album_name] || 0) + 1; });
  const sorted = Object.entries(counts).sort(function(a,b){ return b[1]-a[1]; }).slice(0,12);
  const labels = sorted.map(function(e){ return e[0].length > 15 ? e[0].substring(0,15)+'…' : e[0]; });
  const values = sorted.map(function(e){ return e[1]; });
  if (replayBarInstance) replayBarInstance.destroy();
  const ctx = document.getElementById('replayBarChart').getContext('2d');
  replayBarInstance = new Chart(ctx, {
    type: 'bar',
    data: { labels: labels, datasets: [{ data: values, backgroundColor: '#1DB954', borderRadius: 4 }] },
    options: {
      responsive: true,
      plugins: { legend: { display: false },
        tooltip: { callbacks: {
          title: function(items){ return sorted[items[0].dataIndex][0]; },
          label: function(item){ return item.raw + ' session' + (item.raw !== 1 ? 's' : ''); }
        }}
      },
      scales: {
        x: { ticks: { color: '#aaa', font: { size: 10 } }, grid: { color: '#222' } },
        y: { ticks: { color: '#aaa', stepSize: 1 }, grid: { color: '#222' } }
      }
    }
  });
}

function renderReplayLine(logs) {
  const byDate = {};
  logs.forEach(function(log) {
    const date = log.logged_at.substring(0,10);
    if (!byDate[date]) byDate[date] = {};
    byDate[date][log.album_name] = (byDate[date][log.album_name] || 0) + 1;
  });
  const dates = Object.keys(byDate).sort();
  const totalCounts = {};
  logs.forEach(function(log){ totalCounts[log.album_name] = (totalCounts[log.album_name]||0)+1; });
  const top5 = Object.entries(totalCounts).sort(function(a,b){return b[1]-a[1];}).slice(0,5).map(function(e){return e[0];});
  const colors = ['#1DB954','#6c63ff','#ff6363','#ffb347','#00bcd4'];
  const datasets = top5.map(function(album,i){
    return {
      label: album.length>20?album.substring(0,20)+'…':album,
      data: dates.map(function(date){return (byDate[date]&&byDate[date][album])||0;}),
      borderColor: colors[i], backgroundColor: colors[i]+'33',
      tension: 0.3, fill: false, pointRadius: 4
    };
  });
  if (replayLineInstance) replayLineInstance.destroy();
  const ctx = document.getElementById('replayLineChart').getContext('2d');
  replayLineInstance = new Chart(ctx, {
    type: 'line',
    data: { labels: dates, datasets: datasets },
    options: {
      responsive: true,
      plugins: { legend: { labels: { color: '#aaa', font: { size: 11 } } } },
      scales: {
        x: { ticks: { color: '#aaa', font: { size: 10 } }, grid: { color: '#222' } },
        y: { ticks: { color: '#aaa', stepSize: 1 }, grid: { color: '#222' } }
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
  document.getElementById('recommendations-section').classList.add('hidden');
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
    const safeName = t.name.replace(/\\/g,'\\\\').replace(/'/g,"\\'");
    return '<div class="track-item '+(isSelected?'selected':'')+'" onclick="toggleTrack(\''+safeName+'\', this)">'+
      '<span class="track-check">'+(isSelected?'★':'☆')+'</span>'+
      '<span>'+(i+1)+'. '+t.name+'</span></div>';
  }).join('');

  document.getElementById('modal-body').innerHTML =
    '<div class="modal-album-header">'+
    '<img src="'+(album.images&&album.images[0]?album.images[0].url:'')+'" alt="'+album.name+'" />'+
    '<div><h2>'+album.name+'</h2>'+
    '<p>'+(album.artists&&album.artists[0]?album.artists[0].name:'')+' · '+(album.release_date?album.release_date.split('-')[0]:'')+' </p></div></div>'+
    '<label>Rating (0–10)</label>'+
    '<input type="number" id="rating-input" min="0" max="10" step="0.1" value="'+ratingVal+'" placeholder="e.g. 8.5" />'+
    '<label>Comments</label>'+
    '<textarea id="comment-input" placeholder="Write your thoughts...">'+commentVal+'</textarea>'+
    '<label>Top Songs (tap to mark)</label>'+
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

function closeModal() {
  document.getElementById('modal').classList.add('hidden');
}

// ---- Save Rating ----
async function saveRating(spotifyId) {
  const rating = parseFloat(document.getElementById('rating-input').value);
  const comments = document.getElementById('comment-input').value;
  if (isNaN(rating) || rating < 0 || rating > 10) { alert('Please enter a rating between 0 and 10'); return; }
  const { data: albumRow } = await db.from('albums').upsert({
    spotify_id: spotifyId,
    name: currentAlbum.name,
    artist: currentAlbum.artists[0]?currentAlbum.artists[0].name:'',
    image_url: currentAlbum.images&&currentAlbum.images[0]?currentAlbum.images[0].url:'',
    release_year: currentAlbum.release_date?currentAlbum.release_date.split('-')[0]:''
  }, { onConflict: 'spotify_id' }).select().single();
  if (existingRating) {
    await db.from('ratings').update({ rating, comments, top_songs: selectedTracks, updated_at: new Date().toISOString() }).eq('id', existingRating.id);
  } else {
    await db.from('ratings').insert({ album_id: albumRow.id, rating, comments, top_songs: selectedTracks });
  }
  closeModal();
  alert('Rating saved! ✅');
}

// ---- Charts ----
function renderBarChart(data) {
  const sorted = [...data].sort(function(a,b){ return b.rating-a.rating; });
  const labels = sorted.map(function(r){ return r.albums.name.length>15?r.albums.name.substring(0,15)+'…':r.albums.name; });
  const values = sorted.map(function(r){ return r.rating; });
  const colors = values.map(function(v){ return v>=8?'#1DB954':v>=6?'#17a844':v>=4?'#b3b300':'#cc3300'; });
  if (barChartInstance) barChartInstance.destroy();
  const ctx = document.getElementById('barChart').getContext('2d');
  barChartInstance = new Chart(ctx, {
    type: 'bar',
    data: { labels, datasets: [{ data: values, backgroundColor: colors, borderRadius: 4 }] },
    options: {
      responsive: true,
      plugins: { legend: { display: false },
        tooltip: { callbacks: {
          title: function(items){ return sorted[items[0].dataIndex].albums.name; },
          label: function(item){ return item.raw+' / 10'; }
        }}
      },
      scales: {
        x: { ticks: { color: '#aaa', font: { size: 10 } }, grid: { color: '#222' } },
        y: { min: 0, max: 10, ticks: { color: '#aaa' }, grid: { color: '#222' } }
      }
    }
  });
}

function renderScatterChart(data) {
  const points = data.map(function(r) {
    const year = parseInt(r.albums.release_year) || 0;
    return { x: year, y: r.rating, label: r.albums.name };
  }).filter(function(p){ return p.x > 1900; });

  if (scatterChartInstance) scatterChartInstance.destroy();
  const ctx = document.getElementById('scatterChart').getContext('2d');
  scatterChartInstance = new Chart(ctx, {
    type: 'scatter',
    data: {
      datasets: [{
        data: points,
        backgroundColor: '#1DB954aa',
        borderColor: '#1DB954',
        borderWidth: 1,
        pointRadius: 6,
        pointHoverRadius: 8
      }]
    },
    options: {
      responsive: true,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: function(item) {
              return points[item.dataIndex].label + ' (' + item.parsed.x + ') — ' + item.parsed.y + '/10';
            }
          }
        }
      },
      scales: {
        x: {
          title: { display: true, text: 'Release Year', color: '#555', font: { size: 10 } },
          ticks: { color: '#aaa', font: { size: 10 } },
          grid: { color: '#222' }
        },
        y: {
          min: 0, max: 10,
          title: { display: true, text: 'Your Rating', color: '#555', font: { size: 10 } },
          ticks: { color: '#aaa' },
          grid: { color: '#222' }
        }
      }
    }
  });
}

// ---- Rankings ----
async function loadRankings() {
  const { data } = await db.from('ratings').select('*, albums(*)').order('rating', { ascending: false });
  const container = document.getElementById('rankings-list');
  if (!data || data.length === 0) {
    container.innerHTML = '<div class="empty-state">No ratings yet.<br>Search for an album to get started.</div>';
    return;
  }
  renderBarChart(data);
  renderScatterChart(data);
  container.innerHTML = data.map(function(r, i) {
    const topSongs = r.top_songs&&r.top_songs.length>0?
      '<p style="color:var(--green);font-size:0.75rem;margin-top:4px">★ '+r.top_songs.slice(0,3).join(', ')+'</p>':'';
    const comment = r.comments?
      '<p style="color:var(--text-muted);font-size:0.75rem;margin-top:2px">"'+r.comments.substring(0,60)+(r.comments.length>60?'...':'')+'"</p>':'';
    return '<div class="rankings-item" onclick="openAlbum(\''+r.albums.spotify_id+'\')">'+
      '<div class="rank-num">'+(i+1)+'</div>'+
      '<img src="'+r.albums.image_url+'" alt="'+r.albums.name+'" />'+
      '<div class="rankings-item-info"><h3>'+r.albums.name+'</h3>'+
      '<p>'+r.albums.artist+' · '+(r.albums.release_year||'')+'</p>'+
      topSongs+comment+'</div>'+
      '<div class="big-rating">'+r.rating+'</div></div>';
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
    const token = localStorage.getItem('spotify_token');
    if (token) spotifyToken = token;
  }
  document.getElementById('search-input').addEventListener('keydown', function(e) {
    if (e.key === 'Enter') searchAlbums();
  });
  loadRecentlyPlayed();
  loadRecommendations();
});
