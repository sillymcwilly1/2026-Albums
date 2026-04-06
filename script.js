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

async function loadReplayTracker() {
  var allLogs = [], page = 0;
  while (true) {
    var result = await db.from('play_logs').select('*')
      .order('logged_at', { ascending: true })
      .range(page*1000, (page+1)*1000-1);
    if (result.error || !result.data || result.data.length === 0) break;
    allLogs = allLogs.concat(result.data);
    if (result.data.length < 1000) break;
    page++;
  }
  if (allLogs.length === 0) return;
  renderReplayBar(allLogs);
  renderReplayLine(allLogs);
}

function renderReplayBar(logs) {
  var minuteMap = {};
  logs.forEach(function(log) {
    var mins = log.duration_ms ? Math.round(log.duration_ms/60000) : 0;
    minuteMap[log.album_name] = (minuteMap[log.album_name]||0) + mins;
  });
  var sorted = Object.entries(minuteMap).filter(function(e){return e[1]>0;})
    .sort(function(a,b){return b[1]-a[1];}).slice(0,12);
  if (sorted.length === 0) return;

  var labels = sorted.map(function(e) { return e[0].length>16?e[0].substring(0,15)+'…':e[0]; });
  var values = sorted.map(function(e) { return e[1]; });

  if (replayBarInstance) replayBarInstance.destroy();
  var ctx = document.getElementById('replayBarChart').getContext('2d');
  var grad = ctx.createLinearGradient(0,0,0,300);
  grad.addColorStop(0,'#7a6bbf'); grad.addColorStop(1,'#3c3489');

  replayBarInstance = new Chart(ctx, {
    type: 'bar',
    data: { labels: labels, datasets: [{ data: values, backgroundColor: grad, borderRadius: 4, borderSkipped: false }] },
    options: {
      responsive: true,
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: '#1e1c18', borderColor: '#302e28', borderWidth: 1,
          titleColor: '#f0ece4', bodyColor: '#a8a49a',
          callbacks: {
            title: function(items) { return sorted[items[0].dataIndex][0]; },
            label: function(item) { return item.raw+' min listened'; }
          }
        }
      },
      scales: {
        x: { ticks: { color: '#6a6658', font: { size: 10 } }, grid: { color: '#302e28' } },
        y: { ticks: { color: '#6a6658', callback: function(v){return v+'m';} }, grid: { color: '#302e28' } }
      }
    }
  });
}

function renderReplayLine(logs) {
  var byDate = {};
  logs.forEach(function(log) {
    var date = log.logged_at.substring(0,10);
    var mins = log.duration_ms ? Math.round(log.duration_ms/60000) : 0;
    if (!byDate[date]) byDate[date] = {};
    byDate[date][log.album_name] = (byDate[date][log.album_name]||0) + mins;
  });
  var dates    = Object.keys(byDate).sort();
  var totalMap = {};
  logs.forEach(function(log) {
    var mins = log.duration_ms ? Math.round(log.duration_ms/60000) : 0;
    totalMap[log.album_name] = (totalMap[log.album_name]||0) + mins;
  });
  var top5 = Object.entries(totalMap).filter(function(e){return e[1]>0;})
    .sort(function(a,b){return b[1]-a[1];}).slice(0,5).map(function(e){return e[0];});
  if (top5.length === 0) return;

  var lineColors = ['#7a6bbf','#c47a2e','#c4705a','#3a9e4a','#4a9eff'];
  var datasets   = top5.map(function(album,i) {
    return {
      label: album.length>20?album.substring(0,19)+'…':album,
      data: dates.map(function(d) { return (byDate[d]&&byDate[d][album])||0; }),
      borderColor: lineColors[i], backgroundColor: lineColors[i]+'22',
      tension: 0.4, fill: false, pointRadius: 2, pointHoverRadius: 6, borderWidth: 2
    };
  });

  if (replayLineInstance) replayLineInstance.destroy();
  var ctx = document.getElementById('replayLineChart').getContext('2d');
  replayLineInstance = new Chart(ctx, {
    type: 'line',
    data: { labels: dates, datasets: datasets },
    options: {
      responsive: true,
      plugins: {
        legend: { labels: { color: '#a8a49a', font: { size: 11 }, boxWidth: 10, usePointStyle: true, pointStyle: 'circle' } },
        tooltip: {
          backgroundColor: '#1e1c18', borderColor: '#302e28', borderWidth: 1,
          titleColor: '#f0ece4', bodyColor: '#a8a49a',
          callbacks: { label: function(item) { return ' '+item.dataset.label+': '+item.raw+'m'; } }
        }
      },
      scales: {
        x: {
          ticks: {
            color: '#6a6658', font: { size: 10 }, maxRotation: 0, autoSkip: false,
            callback: function(val,index) {
              var d = dates[index]; if (!d) return '';
              var dt = new Date(d+'T00:00:00');
              if (index===0||dt.getDay()===1) return (dt.getMonth()+1)+'/'+dt.getDate();
              return '';
            }
          },
          grid: { color: '#302e28' }
        },
        y: { ticks: { color: '#6a6658', callback: function(v){return v+'m';} }, grid: { color: '#302e28' } }
      }
    }
  });
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

// Pull starred songs from this week's top 3 albums only
  // (uses all ratings data to find their top_songs, not just this week's ratings)
  var starredSongs = [];

  // First: songs from this week's rated albums
  weekRatings.forEach(function(r) {
    if (r.top_songs && r.top_songs.length > 0) {
      r.top_songs.forEach(function(song) {
        if (starredSongs.length < 9) {
          starredSongs.push({ song: song, album: r.albums.name, artist: r.albums.artist });
        }
      });
    }
  });

  // Second: if we have fewer than 9, fill from recently played albums' ratings
  if (starredSongs.length < 9) {
var recentResult = await db.from('ratings')
      .select('*, albums(*)')
      .order('updated_at', { ascending: false })
      .limit(20);
    var recentRatings = recentResult.data || [];
    (recentRatings || []).forEach(function(r) {
      // Skip albums already included above
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
