// ── Credentials ─────────────────────────────────────────────────
const SPOTIFY_CLIENT_ID = 'b56c5609caa74134987a3d188193cc3f';
const SUPABASE_URL      = 'https://ybqombcywijvkkfedizc.supabase.co';
const SUPABASE_KEY      = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InlicW9tYmN5d2lqdmtrZmVkaXpjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzI0MTQ4MjksImV4cCI6MjA4Nzk5MDgyOX0.1ii1tJKgBy4Asubxb8Zgve5tLcCNFr6dUHK1qD19FVw';

// ── State ────────────────────────────────────────────────────────
var db               = null;
var spotifyToken     = null;
var currentAlbum     = null;
var currentTracks    = [];
var selectedTracks   = [];
var existingRating   = null;
var barChartInstance = null;
var replayBarInstance= null;
var replayLineInstance = null;
var allRatingsData   = [];   // cache for sort without re-fetch
var currentSortMode  = 'score';

// ── Per-album vivid color cache ───────────────────────────────────
// Key: spotify_id  Value: { vivid: [r,g,b], dim: 'rgba(...)', str: 'rgb(...)' }
var albumColorCache  = {};

// ═══════════════════════════════════════════════════════════════
// COLOR SYSTEM
// Sample the most saturated pixel from album art — gives vivid,
// Spotify-Wrapped-level color rather than muddy averages.
// ═══════════════════════════════════════════════════════════════

function sampleVividColor(img) {
  if (!img) return [196, 122, 46];
  try {
    var size = 60;
    var off  = document.createElement('canvas');
    off.width = size; off.height = size;
    var oc   = off.getContext('2d');
    oc.drawImage(img, 0, 0, size, size);
    var pixels   = oc.getImageData(0, 0, size, size).data;
    var bestR = 196, bestG = 122, bestB = 46, bestSat = 0;
    for (var i = 0; i < pixels.length; i += 4) {
      var r = pixels[i], g = pixels[i+1], b = pixels[i+2];
      var mx = Math.max(r,g,b), mn = Math.min(r,g,b);
      var sat = mx - mn;
      if (sat > bestSat && mx > 80) {
        bestSat = sat; bestR = r; bestG = g; bestB = b;
      }
    }
    // Boost toward pure vivid
    var mx2   = Math.max(bestR, bestG, bestB);
    var boost = 220 / Math.max(mx2, 1);
    return [
      Math.min(255, Math.round(bestR * boost)),
      Math.min(255, Math.round(bestG * boost)),
      Math.min(255, Math.round(bestB * boost))
    ];
  } catch(e) { return [196, 122, 46]; }
}

function toRgbStr(rgb, alpha) {
  if (alpha !== undefined) return 'rgba('+rgb[0]+','+rgb[1]+','+rgb[2]+','+alpha+')';
  return 'rgb('+rgb[0]+','+rgb[1]+','+rgb[2]+')';
}

// Load an image and sample its vivid color, storing result in cache
function loadAlbumColor(spotifyId, imageUrl) {
  return new Promise(function(resolve) {
    if (albumColorCache[spotifyId]) { resolve(albumColorCache[spotifyId]); return; }
    if (!imageUrl) {
      var def = { vivid: [196,122,46], str: 'rgb(196,122,46)', dim: 'rgba(196,122,46,0.15)' };
      albumColorCache[spotifyId] = def; resolve(def); return;
    }
    var img = new Image(); img.crossOrigin = 'anonymous';
    img.onload = function() {
      var vivid = sampleVividColor(img);
      var entry = { vivid: vivid, str: toRgbStr(vivid), dim: toRgbStr(vivid, 0.15), img: img };
      albumColorCache[spotifyId] = entry; resolve(entry);
    };
    img.onerror = function() {
      var def = { vivid: [196,122,46], str: 'rgb(196,122,46)', dim: 'rgba(196,122,46,0.15)' };
      albumColorCache[spotifyId] = def; resolve(def);
    };
    img.src = imageUrl;
  });
}

// Apply album color to a card element
function applyAlbumColor(el, colorEntry) {
  if (!el || !colorEntry) return;
  el.style.setProperty('--album-color', colorEntry.str);
  el.style.setProperty('--album-color-dim', colorEntry.dim);
}

// ═══════════════════════════════════════════════════════════════
// SUPABASE + SPOTIFY AUTH
// ═══════════════════════════════════════════════════════════════

function initSupabase() {
  db = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
}

function generateRandomString(length) {
  var chars  = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  var result = '';
  var array  = new Uint8Array(length);
  window.crypto.getRandomValues(array);
  array.forEach(function(byte) { result += chars[byte % chars.length]; });
  return result;
}

async function generateCodeChallenge(codeVerifier) {
  var encoder = new TextEncoder();
  var data    = encoder.encode(codeVerifier);
  var digest  = await window.crypto.subtle.digest('SHA-256', data);
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g,'-').replace(/\//g,'_').replace(/=/g,'');
}

function loginSpotify() {
  var redirectUri  = encodeURIComponent(window.location.origin + window.location.pathname);
  var scopes       = encodeURIComponent('user-read-private user-read-recently-played');
  var codeVerifier = generateRandomString(64);
  localStorage.setItem('code_verifier', codeVerifier);
  generateCodeChallenge(codeVerifier).then(function(codeChallenge) {
    window.location.href = 'https://accounts.spotify.com/authorize?client_id='+SPOTIFY_CLIENT_ID+
      '&response_type=code&redirect_uri='+redirectUri+'&scope='+scopes+
      '&code_challenge_method=S256&code_challenge='+codeChallenge;
  });
}

async function handleSpotifyCallback() {
  var params      = new URLSearchParams(window.location.search);
  var code        = params.get('code');
  if (!code) return false;
  var codeVerifier = localStorage.getItem('code_verifier');
  var redirectUri  = window.location.origin + window.location.pathname;
  var response     = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code', code: code, redirect_uri: redirectUri,
      client_id: SPOTIFY_CLIENT_ID, code_verifier: codeVerifier
    })
  });
  var tokenData = await response.json();
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
  var refreshToken = localStorage.getItem('spotify_refresh_token');
  if (!refreshToken) { loginSpotify(); return false; }
  var response = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token', refresh_token: refreshToken, client_id: SPOTIFY_CLIENT_ID
    })
  });
  var tokenData = await response.json();
  if (tokenData.access_token) { saveTokens(tokenData); return true; }
  loginSpotify(); return false;
}

async function spotifyFetch(url) {
  var token     = localStorage.getItem('spotify_token');
  var savedTime = localStorage.getItem('spotify_token_time');
  var needsRefresh = !token || !savedTime || Date.now() - savedTime >= 55*60*1000;
  if (needsRefresh) {
    var refreshed = await refreshSpotifyToken();
    if (!refreshed) return null;
    token = localStorage.getItem('spotify_token');
  }
  if (!token) return null;
  spotifyToken = token;
  var res = await fetch(url, { headers: { Authorization: 'Bearer '+token } });
  if (res.status === 401) {
    var refreshed2 = await refreshSpotifyToken();
    if (!refreshed2) return null;
    token = localStorage.getItem('spotify_token');
    res   = await fetch(url, { headers: { Authorization: 'Bearer '+token } });
  }
  if (!res.ok) return null;
  return res.json();
}

// ═══════════════════════════════════════════════════════════════
// NAVIGATION
// ═══════════════════════════════════════════════════════════════

function showPage(page) {
  document.querySelectorAll('.page').forEach(function(p) { p.classList.add('hidden'); });
  document.querySelectorAll('.nav-btn').forEach(function(b) { b.classList.remove('active'); });
  document.getElementById('page-'+page).classList.remove('hidden');
  var navBtn = document.getElementById('nav-'+page);
  if (navBtn) navBtn.classList.add('active');

  // Set body data-page for CSS color tokens
  document.body.setAttribute('data-page', page);

  if (page === 'home')     loadHomeDashboard();
  if (page === 'rankings') loadRankings();
  if (page === 'replay')   loadReplayTracker();
}

// ═══════════════════════════════════════════════════════════════
// HOME DASHBOARD
// ═══════════════════════════════════════════════════════════════

async function loadHomeDashboard() {
  // Load stats
  var result = await db.from('ratings').select('*, albums(*)').order('rating', { ascending: false });
  var data   = result.data || [];

  document.getElementById('stat-rated').textContent = data.length || '—';

  if (data.length > 0) {
    var avg = data.reduce(function(s,r) { return s+r.rating; }, 0) / data.length;
    document.getElementById('stat-avg').textContent = avg.toFixed(1);
    document.getElementById('stat-top').textContent = data[0].albums.name.length > 14
      ? data[0].albums.name.substring(0,13)+'…'
      : data[0].albums.name;
  }

  // Recent rated strip — last 8
  var recent  = data.slice(0, 8);
  var strip   = document.getElementById('home-recent-rated');
  strip.innerHTML = '';

  recent.forEach(function(r) {
    var card = document.createElement('div');
    card.className = 'home-recent-card';
    card.onclick   = function() { openAlbum(r.albums.spotify_id); };
    card.innerHTML =
      '<img src="'+r.albums.image_url+'" alt="'+r.albums.name+'" />' +
      '<div class="home-rc-name">'+r.albums.name+'</div>' +
      '<div class="home-rc-score">'+r.rating+'</div>';
    strip.appendChild(card);

    // Color the score with the album's vivid color
    loadAlbumColor(r.albums.spotify_id, r.albums.image_url).then(function(colorEntry) {
      var scoreEl = card.querySelector('.home-rc-score');
      if (scoreEl) scoreEl.style.color = colorEntry.str;
    });
  });
}

// ═══════════════════════════════════════════════════════════════
// RECENTLY PLAYED + PLAY LOGGING
// ═══════════════════════════════════════════════════════════════

async function loadRecentlyPlayed() {
  var token = localStorage.getItem('spotify_token');
  if (!token) return;
  var data  = await spotifyFetch('https://api.spotify.com/v1/me/player/recently-played?limit=50');
  if (!data || !data.items) return;
  await logPlays(data.items);

  var seenIds = new Set();
  var albums  = [];
  data.items.forEach(function(item) {
    var album = item.track.album;
    if (!seenIds.has(album.id)) { seenIds.add(album.id); albums.push(album); }
  });

  var spotifyIds    = albums.map(function(a) { return a.id; });
  var ratedResult   = await db.from('albums').select('spotify_id, ratings(rating)').in('spotify_id', spotifyIds);
  var ratedAlbums   = ratedResult.data || [];
  var ratedMap      = {};
  ratedAlbums.forEach(function(a) {
    if (a.ratings && a.ratings.length > 0) ratedMap[a.spotify_id] = a.ratings[0].rating;
  });

  var container = document.getElementById('recent-results');
  if (!container) return;
  container.innerHTML = '';

  albums.forEach(function(album) {
    var card = buildAlbumCard(album, ratedMap[album.id]);
    container.appendChild(card);
  });
}

function buildAlbumCard(album, ratingVal) {
  var img    = album.images && album.images[0] ? album.images[0].url : '';
  var artist = album.artists && album.artists[0] ? album.artists[0].name : '';
  var card   = document.createElement('div');
  card.className = 'album-card';
  card.onclick   = function() { openAlbum(album.id); };

  var badge = ratingVal !== undefined
    ? '<span class="rating-badge">'+ratingVal+'</span>'
    : '';

  card.innerHTML =
    '<img src="'+img+'" alt="'+album.name+'" />' +
    '<div class="album-card-info">' +
      '<h3>'+album.name+'</h3>' +
      '<p>'+artist+'</p>' +
      badge +
    '</div>';

  // Color the card with album's vivid color
  loadAlbumColor(album.id, img).then(function(colorEntry) {
    applyAlbumColor(card, colorEntry);
    // Also color the rating badge if present
    var badgeEl = card.querySelector('.rating-badge');
    if (badgeEl) {
      badgeEl.style.background  = colorEntry.dim;
      badgeEl.style.color       = colorEntry.str;
      badgeEl.style.border      = '1px solid '+colorEntry.str;
    }
  });

  return card;
}

async function logPlays(items) {
  var now     = new Date();
  var hourKey = now.getFullYear()+'-'+
    String(now.getMonth()+1).padStart(2,'0')+'-'+
    String(now.getDate()).padStart(2,'0')+'T'+
    String(now.getHours()).padStart(2,'0');
  var lastLogged = localStorage.getItem('last_log_hour');
  if (lastLogged) {
    var lastDate   = new Date(lastLogged.replace('T',' ')+':00:00');
    var hoursSince = (now - lastDate) / (1000*60*60);
    if (hoursSince > 2) localStorage.removeItem('last_log_hour');
  }
  if (localStorage.getItem('last_log_hour') === hourKey) return;
  localStorage.setItem('last_log_hour', hourKey);

  var albumMap = {};
  items.forEach(function(item) {
    var album    = item.track.album;
    var duration = item.track.duration_ms || 0;
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

  var toLog = Object.values(albumMap);
  if (toLog.length > 0) {
    var err = await db.from('play_logs').insert(toLog);
    if (err.error) console.error('Play log insert failed:', err.error);
  }
}

// ═══════════════════════════════════════════════════════════════
// SEARCH
// ═══════════════════════════════════════════════════════════════

async function searchAlbums() {
  var token = localStorage.getItem('spotify_token');
  if (!token) { loginSpotify(); return; }
  spotifyToken = token;
  var query = document.getElementById('search-input').value.trim();
  if (!query) return;

  document.getElementById('recent-section').classList.add('hidden');
  document.getElementById('search-results-section').classList.remove('hidden');

  var res = await fetch('https://api.spotify.com/v1/search?q='+encodeURIComponent(query)+'&type=album&limit=10', {
    headers: { Authorization: 'Bearer '+token }
  });
  if (res.status === 401) {
    var r = await refreshSpotifyToken(); if (!r) { loginSpotify(); return; } return searchAlbums();
  }
  if (!res.ok) { alert('Search failed — please try again.'); return; }

  var data = await res.json();
  if (!data.albums || !data.albums.items) { alert('No results found.'); return; }

  var albums     = data.albums.items;
  var spotifyIds = albums.map(function(a) { return a.id; });
  var ratedResult = await db.from('albums').select('spotify_id, ratings(rating)').in('spotify_id', spotifyIds);
  var ratedMap    = {};
  (ratedResult.data||[]).forEach(function(a) {
    if (a.ratings && a.ratings.length > 0) ratedMap[a.spotify_id] = a.ratings[0].rating;
  });

  var container  = document.getElementById('search-results');
  container.innerHTML = '';
  albums.forEach(function(album) {
    var card = buildAlbumCard(album, ratedMap[album.id]);
    container.appendChild(card);
  });
}

// ═══════════════════════════════════════════════════════════════
// ALBUM MODAL — opens with album's vivid color as accent
// ═══════════════════════════════════════════════════════════════

async function openAlbum(spotifyId) {
  var token = localStorage.getItem('spotify_token');
  if (!token) { loginSpotify(); return; }
  spotifyToken = token;

  var albumData  = await spotifyFetch('https://api.spotify.com/v1/albums/'+spotifyId);
  var tracksData = await spotifyFetch('https://api.spotify.com/v1/albums/'+spotifyId+'/tracks?limit=50');
  if (!albumData || !tracksData) return;

  currentAlbum  = albumData;
  currentTracks = tracksData.items;
  selectedTracks = [];
  existingRating = null;

  var existing = await db.from('albums').select('id, ratings(*)').eq('spotify_id', spotifyId).single();
  var ratingVal = '', commentVal = '';
  if (existing.data && existing.data.ratings && existing.data.ratings.length > 0) {
    existingRating = existing.data.ratings[0];
    ratingVal      = existingRating.rating;
    commentVal     = existingRating.comments || '';
    selectedTracks = existingRating.top_songs || [];
  }

  // Get vivid color for this album
  var imgUrl      = albumData.images && albumData.images[0] ? albumData.images[0].url : '';
  var colorEntry  = await loadAlbumColor(spotifyId, imgUrl);

  var tracksHTML  = currentTracks.map(function(t, i) {
    var isSelected = selectedTracks.includes(t.name);
    var safeName   = t.name.replace(/\\/g,'\\\\').replace(/'/g,"\\'");
    return '<div class="track-item '+(isSelected?'selected':'')+'" onclick="toggleTrack(\''+safeName+'\', this)">' +
      '<span class="track-check">'+(isSelected?'★':'☆')+'</span>' +
      '<span>'+(i+1)+'. '+t.name+'</span></div>';
  }).join('');

  var year       = albumData.release_date ? albumData.release_date.split('-')[0] : '';
  var artistName = albumData.artists && albumData.artists[0] ? albumData.artists[0].name : '';

  document.getElementById('modal-body').innerHTML =
    '<div class="modal-album-header">' +
      '<img src="'+imgUrl+'" alt="'+albumData.name+'" />' +
      '<div><h2>'+albumData.name+'</h2><p>'+artistName+'</p>' +
        '<p style="color:var(--text-muted);font-size:0.76rem;margin-top:4px">'+year+'</p></div>' +
    '</div>' +
    '<label>Rating (0–10)</label>' +
    '<input type="number" id="rating-input" min="0" max="10" step="0.1" value="'+ratingVal+'" placeholder="e.g. 8.5" />' +
    '<label>Comments</label>' +
    '<textarea id="comment-input" placeholder="Write your thoughts…">'+commentVal+'</textarea>' +
    '<label>Top Songs</label>' +
    '<div class="tracks-list">'+tracksHTML+'</div>' +
    '<button class="save-btn" onclick="saveRating(\''+spotifyId+'\')">Save Rating</button>';

  // Apply vivid color to modal
  var modalContent = document.querySelector('.modal-content');
  if (modalContent) {
    modalContent.style.setProperty('--modal-accent', colorEntry.str);
  }

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

// ═══════════════════════════════════════════════════════════════
// SAVE RATING
// ═══════════════════════════════════════════════════════════════

async function saveRating(spotifyId) {
  var rating   = parseFloat(document.getElementById('rating-input').value);
  var comments = document.getElementById('comment-input').value;
  if (isNaN(rating) || rating < 0 || rating > 10) { alert('Please enter a rating between 0 and 10'); return; }

  var albumResult = await db.from('albums').upsert({
    spotify_id:   spotifyId,
    name:         currentAlbum.name,
    artist:       currentAlbum.artists[0] ? currentAlbum.artists[0].name : '',
    image_url:    currentAlbum.images && currentAlbum.images[0] ? currentAlbum.images[0].url : '',
    release_year: currentAlbum.release_date ? currentAlbum.release_date.split('-')[0] : ''
  }, { onConflict: 'spotify_id' }).select().single();

  if (existingRating) {
    await db.from('ratings').update({
      rating: rating, comments: comments, top_songs: selectedTracks,
      updated_at: new Date().toISOString()
    }).eq('id', existingRating.id);
  } else {
    await db.from('ratings').insert({
      album_id: albumResult.data.id, rating: rating,
      comments: comments, top_songs: selectedTracks
    });
  }

  closeModal();
  alert('Rating saved! ✅');
}

// ═══════════════════════════════════════════════════════════════
// RANKINGS — album wall, per-album vivid colors
// ═══════════════════════════════════════════════════════════════

async function loadRankings() {
  var result = await db.from('ratings').select('*, albums(*)').order('rating', { ascending: false });
  allRatingsData = result.data || [];
  renderRankings(allRatingsData);
  renderBarChart(allRatingsData);
}

function sortRankings(mode) {
  currentSortMode = mode;
  document.querySelectorAll('.sort-pill').forEach(function(p) { p.classList.remove('sort-pill--active'); });
  var btn = document.getElementById('sort-'+mode);
  if (btn) btn.classList.add('sort-pill--active');

  var sorted = allRatingsData.slice();
  if (mode === 'score') {
    sorted.sort(function(a,b) { return b.rating - a.rating; });
  } else if (mode === 'recent') {
    sorted.sort(function(a,b) { return new Date(b.updated_at||b.created_at) - new Date(a.updated_at||a.created_at); });
  } else if (mode === 'artist') {
    sorted.sort(function(a,b) { return a.albums.artist.localeCompare(b.albums.artist); });
  }
  renderRankings(sorted);
}

function renderRankings(data) {
  var container = document.getElementById('rankings-list');
  if (!data || data.length === 0) {
    container.innerHTML = '<div style="color:var(--text-muted);text-align:center;padding:80px 0;font-style:italic">Nothing rated yet — head to Search to get started.</div>';
    return;
  }

  container.innerHTML = '';

  data.forEach(function(r, i) {
    var card = document.createElement('div');
    card.className = 'rankings-wall-card';
    if (i === 0) card.classList.add('rankings-wall-card--1');
    if (i === 1) card.classList.add('rankings-wall-card--2');
    if (i === 2) card.classList.add('rankings-wall-card--3');

    card.onclick = function() { openAlbum(r.albums.spotify_id); };

    card.innerHTML =
      '<img src="'+r.albums.image_url+'" alt="'+r.albums.name+'" />' +
      '<div class="wall-overlay">' +
        '<div class="wall-score" id="wall-score-'+r.id+'">'+r.rating+'</div>' +
        '<div class="wall-name">'+r.albums.name+'</div>' +
        '<div class="wall-artist">'+r.albums.artist+'</div>' +
      '</div>' +
      '<div class="wall-rank" id="wall-rank-'+r.id+'">#'+(i+1)+'</div>';

    container.appendChild(card);

    // Color the score and rank badge with vivid album color
    loadAlbumColor(r.albums.spotify_id, r.albums.image_url).then(function(colorEntry) {
      var scoreEl = document.getElementById('wall-score-'+r.id);
      var rankEl  = document.getElementById('wall-rank-'+r.id);
      if (scoreEl) scoreEl.style.color = colorEntry.str;
      if (rankEl) {
        rankEl.style.color      = colorEntry.str;
        rankEl.style.background = toRgbStr(colorEntry.vivid, 0.18);
        rankEl.style.backdropFilter = 'blur(4px)';
      }
      card.style.setProperty('--album-color', colorEntry.str);
    });
  });
}

function renderBarChart(data) {
  var sorted = data.slice().sort(function(a,b) { return b.rating - a.rating; });
  var labels = sorted.map(function(r) {
    var n = r.albums.name; return n.length > 16 ? n.substring(0,15)+'…' : n;
  });
  var values = sorted.map(function(r) { return r.rating; });
  var colors = sorted.map(function(r) {
    var c = albumColorCache[r.albums.spotify_id];
    return c ? c.str : 'rgba(196,122,46,0.8)';
  });

  if (barChartInstance) barChartInstance.destroy();
  var ctx = document.getElementById('barChart').getContext('2d');
  barChartInstance = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: labels,
      datasets: [{
        data: values,
        backgroundColor: colors,
        borderRadius: 4,
        borderSkipped: false
      }]
    },
    options: {
      responsive: true,
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: '#1e1c18', borderColor: '#302e28', borderWidth: 1,
          titleColor: '#f0ece4', bodyColor: '#a8a49a',
          callbacks: {
            title: function(items) { return sorted[items[0].dataIndex].albums.name; },
            label: function(item) {
              var r = sorted[item.dataIndex];
              return ' '+item.raw+' / 10  —  '+r.albums.artist;
            }
          }
        }
      },
      scales: {
        x: { ticks: { color: '#6a6658', font: { size: 10 } }, grid: { color: '#302e28' } },
        y: {
          min: 0, max: 10,
          ticks: { color: '#6a6658', callback: function(v) { return v%2===0?v:''; } },
          grid: { color: '#302e28' }
        }
      }
    }
  });
}

// ═══════════════════════════════════════════════════════════════
// REPLAY TRACKER
// ═══════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════
// REPLAY TRACKER — full dashboard
// ═══════════════════════════════════════════════════════════════

// Module-level state for scrollable sections
var _replayLogs     = [];
var _replayByDate   = {};   // { 'YYYY-MM-DD': { albumName: mins } }
var _replayAllDates = [];   // sorted array of all date strings
var _dowWeekOffset  = 0;    // 0 = current week, -1 = previous, etc.
var _calWeekOffset  = 0;    // 0 = last 12 weeks, -12 = previous 12, etc.

async function loadReplayTracker() {
  var allLogs = [], pg = 0;
  while (true) {
    var result = await db.from('play_logs').select('*')
      .order('logged_at', { ascending: true })
      .range(pg*1000, (pg+1)*1000-1);
    if (result.error || !result.data || result.data.length === 0) break;
    allLogs = allLogs.concat(result.data);
    if (result.data.length < 1000) break;
    pg++;
  }
  if (allLogs.length === 0) return;

  _replayLogs = allLogs;

  // Build byDate map
  _replayByDate = {};
  allLogs.forEach(function(log) {
    var date = log.logged_at.substring(0,10);
    var mins = log.duration_ms ? Math.round(log.duration_ms/60000) : 0;
    if (!_replayByDate[date]) _replayByDate[date] = {};
    _replayByDate[date][log.album_name] = (_replayByDate[date][log.album_name]||0) + mins;
  });
  _replayAllDates = Object.keys(_replayByDate).sort();

  _dowWeekOffset = 0;
  _calWeekOffset = 0;

  renderReplayStats();
  renderReplayBar();
  renderReplayDow();
  renderReplayInsights();
  renderReplayCal();
  wireReplayNav();
}

function renderReplayStats() {
  // This week minutes
  var now     = new Date();
  var weekAgo = new Date(); weekAgo.setDate(now.getDate()-7);
  var weekMins = 0, weekSessions = 0, weekAlbums = new Set(), dowMap = {};
  _replayLogs.forEach(function(log) {
    var d = new Date(log.logged_at);
    if (d < weekAgo) return;
    var mins = log.duration_ms ? Math.round(log.duration_ms/60000) : 0;
    weekMins += mins; weekSessions++;
    weekAlbums.add(log.album_name);
    var day = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][d.getDay()];
    dowMap[day] = (dowMap[day]||0) + mins;
  });
  var peakDay = Object.entries(dowMap).sort(function(a,b){return b[1]-a[1];})[0];

  var el = function(id) { return document.getElementById(id); };
  if (el('rstat-mins'))    el('rstat-mins').textContent    = weekMins+'m';
  if (el('rstat-sessions'))el('rstat-sessions').textContent= weekSessions;
  if (el('rstat-albums'))  el('rstat-albums').textContent  = weekAlbums.size;
  if (el('rstat-peak'))    el('rstat-peak').textContent    = peakDay ? peakDay[0] : '—';
}

function renderReplayBar() {
  var minuteMap = {};
  _replayLogs.forEach(function(log) {
    var mins = log.duration_ms ? Math.round(log.duration_ms/60000) : 0;
    minuteMap[log.album_name] = (minuteMap[log.album_name]||0) + mins;
  });
  var sorted = Object.entries(minuteMap).filter(function(e){return e[1]>0;})
    .sort(function(a,b){return b[1]-a[1];}).slice(0,8);
  if (!sorted.length) return;

  var maxVal = sorted[0][1];
  var container = document.getElementById('replay-bar-list');
  if (!container) return;
  container.innerHTML = '';

  sorted.forEach(function(entry) {
    var name = entry[0], mins = entry[1];
    var pct  = Math.round((mins/maxVal)*100);

    // Look up cached color for this album
    var colorEntry = null;
    Object.keys(albumColorCache).forEach(function(id) {
      if (albumColorCache[id] && albumColorCache[id].albumName === name) colorEntry = albumColorCache[id];
    });
    // Fallback: find by album name across cache
    if (!colorEntry) {
      var keys = Object.keys(albumColorCache);
      for (var ki=0; ki<keys.length; ki++) {
        // store album name on cache entries when we load them
      }
    }
    var barColor = colorEntry ? colorEntry.str : 'rgba(255,255,255,0.6)';

    var row = document.createElement('div');
    row.className = 'replay-bar-row';
    row.innerHTML =
      '<div class="replay-bar-art"></div>' +
      '<div class="replay-bar-name" title="'+name+'">'+(name.length>18?name.substring(0,17)+'…':name)+'</div>' +
      '<div class="replay-bar-track"><div class="replay-bar-fill" style="width:'+pct+'%;background:'+barColor+'"></div></div>' +
      '<div class="replay-bar-val">'+mins+'m</div>';

    // Fill art from albumColorCache image if available
    var artEl = row.querySelector('.replay-bar-art');
    var found = false;
    Object.keys(albumColorCache).forEach(function(id) {
      var ce = albumColorCache[id];
      if (!found && ce && ce.img) {
        // match by checking if img src contains album-related data — use first match heuristic
      }
    });

    container.appendChild(row);

    // Load art from albums table
    db.from('albums').select('image_url,spotify_id').ilike('name', '%'+name.substring(0,10)+'%').limit(1)
      .then(function(res) {
        if (res.data && res.data[0] && res.data[0].image_url) {
          artEl.style.backgroundImage    = 'url('+res.data[0].image_url+')';
          artEl.style.backgroundSize     = 'cover';
          artEl.style.backgroundPosition = 'center';
          // Update bar color from cache
          var sid = res.data[0].spotify_id;
          if (albumColorCache[sid]) {
            row.querySelector('.replay-bar-fill').style.background = albumColorCache[sid].str;
          } else {
            loadAlbumColor(sid, res.data[0].image_url).then(function(ce) {
              row.querySelector('.replay-bar-fill').style.background = ce.str;
            });
          }
        }
      });
  });
}

function getDowDataForWeek(offset) {
  // Returns { Mon:mins, Tue:mins, ... } for the week starting (offset) weeks ago
  var now     = new Date();
  // Find Monday of current week
  var dow     = now.getDay(); // 0=Sun
  var monday  = new Date(now);
  monday.setDate(now.getDate() - (dow === 0 ? 6 : dow-1) + offset*7);
  monday.setHours(0,0,0,0);
  var dayNames = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];
  var result   = {};
  dayNames.forEach(function(d) { result[d] = 0; });

  for (var di=0; di<7; di++) {
    var d2 = new Date(monday); d2.setDate(monday.getDate()+di);
    var key = d2.toISOString().substring(0,10);
    var dayName = dayNames[di];
    if (_replayByDate[key]) {
      Object.values(_replayByDate[key]).forEach(function(v) { result[dayName] += v; });
    }
  }
  return { data: result, monday: monday };
}

function renderReplayDow() {
  var info    = getDowDataForWeek(_dowWeekOffset);
  var data    = info.data;
  var monday  = info.monday;
  var sunday  = new Date(monday); sunday.setDate(monday.getDate()+6);

  var fmt = function(d) { return (d.getMonth()+1)+'/'+d.getDate(); };
  var rangeLabel = _dowWeekOffset === 0
    ? 'This week'
    : fmt(monday)+' – '+fmt(sunday);
  var rangeEl = document.getElementById('dow-range-label');
  if (rangeEl) rangeEl.textContent = rangeLabel;

  var maxVal = Math.max(1, Math.max.apply(null, Object.values(data)));
  var dayNames = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];
  var grid = document.getElementById('dow-grid');
  if (!grid) return;
  grid.innerHTML = '';

  dayNames.forEach(function(day) {
    var mins = data[day] || 0;
    var pct  = Math.round((mins/maxVal)*100);
    var isPeak = mins === maxVal && mins > 0;
    var col = document.createElement('div');
    col.className = 'replay-dow-col';
    col.innerHTML =
      '<div class="replay-dow-bar-wrap">' +
        '<div class="replay-dow-bar'+(isPeak?' peak':'')+'" style="height:'+Math.max(4,pct)+'%"></div>' +
      '</div>' +
      '<div class="replay-dow-lbl">'+day.substring(0,1)+'</div>' +
      '<div class="replay-dow-val'+(isPeak?' peak':'')+'">'+mins+'m</div>';
    grid.appendChild(col);
  });
}

function renderReplayInsights() {
  var container = document.getElementById('replay-insights');
  if (!container) return;

  // Calculate insights from data
  var now = new Date();
  var weekAgo = new Date(); weekAgo.setDate(now.getDate()-7);
  var twoWeeksAgo = new Date(); twoWeeksAgo.setDate(now.getDate()-14);

  var thisMins = 0, lastMins = 0;
  var albumDays = {}, streakDays = 0;

  _replayLogs.forEach(function(log) {
    var d    = new Date(log.logged_at);
    var mins = log.duration_ms ? Math.round(log.duration_ms/60000) : 0;
    if (d >= weekAgo)    thisMins += mins;
    else if (d >= twoWeeksAgo) lastMins += mins;
    if (d >= weekAgo) albumDays[log.album_name] = (albumDays[log.album_name]||new Set());
    if (d >= weekAgo) albumDays[log.album_name].add(log.logged_at.substring(0,10));
  });

  // Streak
  var today = now.toISOString().substring(0,10);
  var checkDate = new Date(now);
  streakDays = 0;
  while (true) {
    var key = checkDate.toISOString().substring(0,10);
    if (_replayByDate[key]) { streakDays++; checkDate.setDate(checkDate.getDate()-1); }
    else break;
  }

  // Most replayed this week
  var topAlbumEntry = Object.entries(albumDays).sort(function(a,b){ return b[1].size-a[1].size; })[0];
  var topAlbumName  = topAlbumEntry ? topAlbumEntry[0] : null;
  var topAlbumDays  = topAlbumEntry ? topAlbumEntry[1].size : 0;

  // DOW peak all time
  var dowTotals = {Mon:0,Tue:0,Wed:0,Thu:0,Fri:0,Sat:0,Sun:0};
  var dayIdx    = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  _replayLogs.forEach(function(log) {
    var d = new Date(log.logged_at);
    var mins = log.duration_ms ? Math.round(log.duration_ms/60000) : 0;
    var dn = dayIdx[d.getDay()];
    if (dowTotals[dn] !== undefined) dowTotals[dn] += mins;
  });
  var peakDow = Object.entries(dowTotals).sort(function(a,b){return b[1]-a[1];})[0];

  var pctChange = lastMins > 0 ? Math.round(((thisMins-lastMins)/lastMins)*100) : null;

  var svgStreak =
    '<svg width="28" height="28" viewBox="0 0 28 28" fill="none">'+
    '<rect x="2" y="20" width="4" height="6" rx="1" fill="rgba(255,255,255,0.3)"/>'+
    '<rect x="8" y="16" width="4" height="10" rx="1" fill="rgba(255,255,255,0.45)"/>'+
    '<rect x="14" y="11" width="4" height="15" rx="1" fill="rgba(255,255,255,0.65)"/>'+
    '<rect x="20" y="5" width="4" height="21" rx="1" fill="#fff"/>'+
    '<path d="M22 4 L20 7 L24 7 Z" fill="#fff"/>'+
    '</svg>';

  var svgTrend = pctChange !== null && pctChange >= 0
    ? '<svg width="28" height="28" viewBox="0 0 28 28" fill="none">'+
      '<line x1="2" y1="24" x2="26" y2="24" stroke="rgba(255,255,255,0.25)" stroke-width="1"/>'+
      '<polyline points="3,21 9,17 15,13 21,7" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" fill="none"/>'+
      '<path d="M19 5 L23 7 L21 11" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" fill="none"/>'+
      '</svg>'
    : '<svg width="28" height="28" viewBox="0 0 28 28" fill="none">'+
      '<line x1="2" y1="4" x2="26" y2="4" stroke="rgba(255,255,255,0.25)" stroke-width="1"/>'+
      '<polyline points="3,7 9,11 15,15 21,21" stroke="rgba(255,255,255,0.6)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" fill="none"/>'+
      '<path d="M19 23 L23 21 L21 17" stroke="rgba(255,255,255,0.6)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" fill="none"/>'+
      '</svg>';

  var svgSun =
    '<svg width="28" height="28" viewBox="0 0 28 28" fill="none">'+
    '<circle cx="14" cy="14" r="5" fill="#fff"/>'+
    '<line x1="14" y1="2" x2="14" y2="6" stroke="#fff" stroke-width="1.5" stroke-linecap="round"/>'+
    '<line x1="14" y1="22" x2="14" y2="26" stroke="#fff" stroke-width="1.5" stroke-linecap="round"/>'+
    '<line x1="2" y1="14" x2="6" y2="14" stroke="#fff" stroke-width="1.5" stroke-linecap="round"/>'+
    '<line x1="22" y1="14" x2="26" y2="14" stroke="#fff" stroke-width="1.5" stroke-linecap="round"/>'+
    '<line x1="5" y1="5" x2="8" y2="8" stroke="rgba(255,255,255,0.55)" stroke-width="1.5" stroke-linecap="round"/>'+
    '<line x1="20" y1="20" x2="23" y2="23" stroke="rgba(255,255,255,0.55)" stroke-width="1.5" stroke-linecap="round"/>'+
    '<line x1="23" y1="5" x2="20" y2="8" stroke="rgba(255,255,255,0.55)" stroke-width="1.5" stroke-linecap="round"/>'+
    '<line x1="5" y1="23" x2="8" y2="20" stroke="rgba(255,255,255,0.55)" stroke-width="1.5" stroke-linecap="round"/>'+
    '</svg>';

  var svgRepeat =
    '<svg width="28" height="28" viewBox="0 0 28 28" fill="none">'+
    '<path d="M6 14 A8 8 0 0 1 22 14" stroke="#fff" stroke-width="2" stroke-linecap="round" fill="none"/>'+
    '<path d="M22 14 A8 8 0 0 1 6 14" stroke="rgba(255,255,255,0.4)" stroke-width="2" stroke-linecap="round" fill="none"/>'+
    '<path d="M20 11 L23 14 L20 17" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" fill="none"/>'+
    '<path d="M8 17 L5 14 L8 11" stroke="rgba(255,255,255,0.4)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" fill="none"/>'+
    '<circle cx="14" cy="14" r="2" fill="#fff"/>'+
    '</svg>';

  var insights = [
    {
      icon: svgStreak,
      text: streakDays > 1
        ? '<strong>'+streakDays+'-day streak</strong> — you\'ve listened every day'
        : 'No current streak — open the app daily to build one'
    },
    pctChange !== null ? {
      icon: svgTrend,
      text: pctChange >= 0
        ? 'Up <strong>'+pctChange+'%</strong> vs last week\'s '+lastMins+'m'
        : 'Down <strong>'+Math.abs(pctChange)+'%</strong> vs last week\'s '+lastMins+'m'
    } : null,
    peakDow && peakDow[1] > 0 ? {
      icon: svgSun,
      text: '<strong>'+peakDow[0]+'</strong> is your biggest listening day all time'
    } : null,
    topAlbumName ? {
      icon: svgRepeat,
      text: '<strong>'+
        (topAlbumName.length>22?topAlbumName.substring(0,21)+'…':topAlbumName)+
        '</strong> played '+topAlbumDays+' of the last 7 days'
    } : null
  ];

  container.innerHTML = insights.filter(Boolean).map(function(ins) {
    return '<div class="replay-insight-item">'+
      '<div class="replay-insight-icon">'+ins.icon+'</div>'+
      '<div class="replay-insight-text">'+ins.text+'</div>'+
    '</div>';
  }).join('');
}

function renderReplayCal() {
  var container = document.getElementById('replay-cal');
  if (!container) return;
  container.innerHTML = '';

  // Show 12 weeks ending at (today + calWeekOffset*7)
  var endDate   = new Date();
  endDate.setDate(endDate.getDate() + _calWeekOffset*7);
  var startDate = new Date(endDate);
  startDate.setDate(endDate.getDate() - 83); // 12 weeks = 84 days

  // Update range label
  var fmt = function(d) { return ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][d.getMonth()]+' '+d.getDate(); };
  var lbl = document.getElementById('cal-range-label');
  if (lbl) lbl.textContent = fmt(startDate)+' – '+fmt(endDate);

  // Top 5 albums for Y-axis labels
  var totalMap = {};
  _replayLogs.forEach(function(log) {
    var mins = log.duration_ms ? Math.round(log.duration_ms/60000) : 0;
    totalMap[log.album_name] = (totalMap[log.album_name]||0) + mins;
  });
  var top5Albums = Object.entries(totalMap)
    .sort(function(a,b){return b[1]-a[1];}).slice(0,5).map(function(e){return e[0];});

  // Build grid: rows = albums (+ 1 total row), cols = 84 days
  var numRows   = top5Albums.length + 1; // +1 for "total" row
  var numCols   = 84;
  var cellSize  = 14;
  var cellGap   = 3;
  var labelW    = 90; // width reserved for album name labels
  var colW      = cellSize + cellGap;
  var rowH      = cellSize + cellGap;
  var headerH   = 20; // month label row height

  var totalW    = labelW + numCols * colW;
  var totalH    = headerH + numRows * rowH;

  var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('width', totalW);
  svg.setAttribute('height', totalH);
  svg.style.display = 'block';

  // Month labels
  var prevMonth = -1;
  for (var ci=0; ci<numCols; ci++) {
    var d = new Date(startDate); d.setDate(startDate.getDate()+ci);
    if (d.getDate() <= 7 && d.getMonth() !== prevMonth) {
      prevMonth = d.getMonth();
      var mNames = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
      var t = document.createElementNS('http://www.w3.org/2000/svg','text');
      t.setAttribute('x', labelW + ci*colW);
      t.setAttribute('y', 12);
      t.setAttribute('font-size', '9');
      t.setAttribute('fill', 'rgba(255,255,255,0.32)');
      t.setAttribute('font-family', 'DM Sans,sans-serif');
      t.textContent = mNames[d.getMonth()];
      svg.appendChild(t);
    }
  }

  // Row labels + cells
  var rowLabels = ['Total'].concat(top5Albums);
  rowLabels.forEach(function(albumName, ri) {
    var y = headerH + ri * rowH;

    // Label
    var lbl = document.createElementNS('http://www.w3.org/2000/svg','text');
    lbl.setAttribute('x', 0);
    lbl.setAttribute('y', y + cellSize - 2);
    lbl.setAttribute('font-size', '9');
    lbl.setAttribute('fill', 'rgba(255,255,255,0.4)');
    lbl.setAttribute('font-family', 'DM Sans,sans-serif');
    var shortName = albumName.length > 11 ? albumName.substring(0,10)+'…' : albumName;
    lbl.textContent = shortName;
    svg.appendChild(lbl);

    // Find max for this row (for opacity scaling)
    var rowMax = 1;
    for (var ci2=0; ci2<numCols; ci2++) {
      var d2 = new Date(startDate); d2.setDate(startDate.getDate()+ci2);
      var key2 = d2.toISOString().substring(0,10);
      var val2 = 0;
      if (_replayByDate[key2]) {
        if (ri === 0) {
          Object.values(_replayByDate[key2]).forEach(function(v){val2+=v;});
        } else {
          val2 = _replayByDate[key2][albumName]||0;
        }
      }
      if (val2 > rowMax) rowMax = val2;
    }

    // Cells
    for (var ci=0; ci<numCols; ci++) {
      var d = new Date(startDate); d.setDate(startDate.getDate()+ci);
      var key = d.toISOString().substring(0,10);
      var val = 0;
      if (_replayByDate[key]) {
        if (ri === 0) {
          Object.values(_replayByDate[key]).forEach(function(v){val+=v;});
        } else {
          val = _replayByDate[key][albumName]||0;
        }
      }
      var opacity = val > 0 ? Math.max(0.15, Math.min(0.95, val/rowMax*0.9)) : 0.05;
      var rect = document.createElementNS('http://www.w3.org/2000/svg','rect');
      rect.setAttribute('x', labelW + ci*colW);
      rect.setAttribute('y', y);
      rect.setAttribute('width', cellSize);
      rect.setAttribute('height', cellSize);
      rect.setAttribute('rx', 2);
      rect.setAttribute('fill', 'rgba(255,255,255,'+opacity.toFixed(2)+')');
      rect.setAttribute('data-tip', (val>0?val+'m on ':'')+key);
      svg.appendChild(rect);
    }
  });

  container.appendChild(svg);
}

function wireReplayNav() {
  var dowPrev = document.getElementById('dow-prev');
  var dowNext = document.getElementById('dow-next');
  var calPrev = document.getElementById('cal-prev');
  var calNext = document.getElementById('cal-next');

  if (dowPrev) dowPrev.onclick = function() {
    _dowWeekOffset--; renderReplayDow();
    if (dowNext) dowNext.disabled = false;
  };
  if (dowNext) dowNext.onclick = function() {
    if (_dowWeekOffset < 0) { _dowWeekOffset++; renderReplayDow(); }
    if (_dowWeekOffset >= 0 && dowNext) dowNext.disabled = true;
  };
  if (calPrev) calPrev.onclick = function() {
    _calWeekOffset -= 12; renderReplayCal();
    if (calNext) calNext.disabled = false;
  };
  if (calNext) calNext.onclick = function() {
    if (_calWeekOffset < 0) { _calWeekOffset += 12; if (_calWeekOffset > 0) _calWeekOffset = 0; renderReplayCal(); }
    if (_calWeekOffset >= 0 && calNext) calNext.disabled = true;
  };
}

// ═══════════════════════════════════════════════════════════════
// WEEK IN REVIEW — generateWeekReview delegates to drawCard
// ═══════════════════════════════════════════════════════════════

async function generateWeekReview() {
  var endDate   = new Date();
  var startDate = new Date(); startDate.setDate(endDate.getDate()-7);

  document.getElementById('week-loading').classList.remove('hidden');
  document.getElementById('week-output').classList.add('hidden');
  document.getElementById('week-empty').classList.add('hidden');

  var rUResult = await db.from('ratings').select('*, albums(*)')
    .gte('updated_at',startDate.toISOString()).lt('updated_at',endDate.toISOString());
  var rCResult = await db.from('ratings').select('*, albums(*)')
    .gte('created_at',startDate.toISOString()).lt('created_at',endDate.toISOString());

  var rmap = {};
  [...(rUResult.data||[]),...(rCResult.data||[])].forEach(function(r) { rmap[r.id]=r; });
  var weekRatings = Object.values(rmap).sort(function(a,b){return b.rating-a.rating;});

  var plResult = await db.from('play_logs').select('*')
    .gte('logged_at',startDate.toISOString()).lt('logged_at',endDate.toISOString());
  var playLogs = plResult.data || [];

  if (!weekRatings.length && !playLogs.length) {
    document.getElementById('week-loading').classList.add('hidden');
    document.getElementById('week-empty').classList.remove('hidden'); return;
  }

  var totalMins = playLogs.reduce(function(s,l){return s+(l.duration_ms?Math.round(l.duration_ms/60000):0);},0);

  var albumMins = {};
  playLogs.forEach(function(l) {
    var m = l.duration_ms?Math.round(l.duration_ms/60000):0;
    if (m>0) albumMins[l.album_name]=(albumMins[l.album_name]||0)+m;
  });

  var byDate = {};
  playLogs.forEach(function(l) {
    var date = l.logged_at.substring(0,10);
    var m    = l.duration_ms?Math.round(l.duration_ms/60000):0;
    if (!byDate[date]) byDate[date]={};
    byDate[date][l.album_name]=(byDate[date][l.album_name]||0)+m;
  });

  var top5forChart  = Object.entries(albumMins).sort(function(a,b){return b[1]-a[1];}).slice(0,5).map(function(e){return e[0];});
  var lineColors    = ['#1DB954','#e8a030','#e05a3a','#4a9eff','#c084fc'];

var starredSongs = [];
  weekRatings.forEach(function(r) {
    if (r.top_songs && r.top_songs.length > 0) {
      r.top_songs.forEach(function(song) {
        if (starredSongs.length < 9) {
          starredSongs.push({ song: song, album: r.albums.name, artist: r.albums.artist });
        }
      });
    }
  });

  if (starredSongs.length < 9) {
    var recentResult = await db.from('ratings')
      .select('*, albums(*)')
      .order('updated_at', { ascending: false })
      .limit(20);
    var recentRatings = recentResult.data || [];
    (recentRatings || []).forEach(function(r) {
      var alreadyIncluded = weekRatings.some(function(wr) { return wr.id === r.id; });
      if (alreadyIncluded) return;
      if (r.top_songs && r.top_songs.length > 0) {
        r.top_songs.forEach(function(song) {
          if (starredSongs.length < 9) {
            starredSongs.push({ song: song, album: r.albums.name, artist: r.albums.artist });
          }
        });
      }
    });
  }

  var top3     = weekRatings.slice(0,3);
  var avgScore = top3.length?(top3.reduce(function(s,r){return s+r.rating;},0)/top3.length).toFixed(1):'—';
  var totalStarred = weekRatings.reduce(function(s,r){return s+(r.top_songs?r.top_songs.length:0);},0);

  // Load art images
  var artImages = await Promise.all(top3.map(function(r) {
    return new Promise(function(resolve) {
      if (!r.albums.image_url){resolve(null);return;}
      var img=new Image(); img.crossOrigin='anonymous';
      img.onload=function(){resolve(img);}; img.onerror=function(){resolve(null);};
      img.src=r.albums.image_url;
    });
  }));

  // Sample vivid colors — one per album, reused consistently
  var sampledColors = artImages.map(function(img) { return sampleVividColor(img); });
  var blended       = sampledColors[0]||[196,122,46];
  var accentColors  = sampledColors;

  // All-time rating distribution
  var allRatingsResult = await db.from('ratings').select('rating');
  var ratingBuckets    = {'1-4':0,'5-6':0,'7-8':0,'9-10':0};
  (allRatingsResult.data||[]).forEach(function(r) {
    if (r.rating>=9) ratingBuckets['9-10']++;
    else if (r.rating>=7) ratingBuckets['7-8']++;
    else if (r.rating>=5) ratingBuckets['5-6']++;
    else ratingBuckets['1-4']++;
  });
  var totalAllTimeCount = (allRatingsResult.data||[]).length;

  // This week's bucket breakdown
  var weekRatingBuckets = {'1-4':0,'5-6':0,'7-8':0,'9-10':0};
  weekRatings.forEach(function(r) {
    if (r.rating>=9) weekRatingBuckets['9-10']++;
    else if (r.rating>=7) weekRatingBuckets['7-8']++;
    else if (r.rating>=5) weekRatingBuckets['5-6']++;
    else weekRatingBuckets['1-4']++;
  });

  document.getElementById('week-loading').classList.add('hidden');

  drawCard({
    startDate:startDate, endDate:endDate,
    top3:top3, artImages:artImages,
    totalMins:totalMins, avgScore:avgScore,
    totalRated:weekRatings.length, totalStarred:totalStarred, starredSongs:starredSongs,
    byDate:byDate, top5forChart:top5forChart, lineColors:lineColors,
    blended:blended, accentColors:accentColors, albumMinsMap:albumMins,
    ratingBuckets:ratingBuckets, totalAllTime:totalAllTimeCount,
    weekRatingBuckets:weekRatingBuckets
  });

  document.getElementById('week-output').classList.remove('hidden');
}

function downloadWeekCard() {
  var canvas = document.getElementById('weekCanvas');
  canvas.toBlob(function(blob) {
    var url = URL.createObjectURL(blob);
    var a   = document.createElement('a');
    a.href  = url; a.download = 'week-in-review.png';
    document.body.appendChild(a); a.click();
    setTimeout(function(){document.body.removeChild(a);URL.revokeObjectURL(url);},100);
  },'image/png');
}

// ═══════════════════════════════════════════════════════════════
// EXPOSE GLOBALS
// ═══════════════════════════════════════════════════════════════

window.showPage          = showPage;
window.searchAlbums      = searchAlbums;
window.openAlbum         = openAlbum;
window.toggleTrack       = toggleTrack;
window.closeModal        = closeModal;
window.saveRating        = saveRating;
window.sortRankings      = sortRankings;
window.generateWeekReview= generateWeekReview;
window.downloadWeekCard  = downloadWeekCard;

// ═══════════════════════════════════════════════════════════════
// INIT
// ═══════════════════════════════════════════════════════════════

window.addEventListener('load', async function() {
  initSupabase();

  var params = new URLSearchParams(window.location.search);
  if (params.get('code')) {
    await handleSpotifyCallback();
  } else {
    var token = localStorage.getItem('spotify_token');
    if (token) spotifyToken = token;
  }

  document.getElementById('search-input').addEventListener('keydown', function(e) {
    if (e.key === 'Enter') searchAlbums();
  });

  // Start on home page
  showPage('home');
  loadRecentlyPlayed();
});
