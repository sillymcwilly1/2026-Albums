// ================================================================
// WEEK IN REVIEW — drawCard()
//
// FORMAT: Collage poster. No dark background. The albums ARE the card.
//
// LAYOUT (1080 × 1920):
//   0    –  540   Slayyyter zone: vivid album-1 color, score hero
//   490  –  610   Diagonal sepia band (album 3 color)
//   540  – 1920   Warm cream-gold zone (album 2 color tint)
//   560  –  770   Albums 2 & 3 cards (white cards on cream)
//   770  –  930   Heat map grid
//   930  – 1200   Setlist (starred songs)
//   1200 – 1920   Red footer band with stats
//
// COLORS: sampled from actual album art — vivid saturation sampling
// ================================================================

var CW_CARD  = 1080;
var CH_CARD  = 1920;
var PAD_CARD = 56;

// ── Color helpers ─────────────────────────────────────────────

function sampleVividColor(img) {
  if (!img) return [232, 0, 26];
  try {
    var size = 80;
    var off  = document.createElement('canvas');
    off.width = size; off.height = size;
    var oc   = off.getContext('2d');
    oc.drawImage(img, 0, 0, size, size);
    var px   = oc.getImageData(0, 0, size, size).data;
    var bestR = 232, bestG = 0, bestB = 26, bestSat = 0;
    for (var i = 0; i < px.length; i += 4) {
      var r = px[i], g = px[i+1], b = px[i+2];
      var mx = Math.max(r,g,b), mn = Math.min(r,g,b);
      var sat = mx - mn;
      if (sat > bestSat && mx > 60) {
        bestSat = sat; bestR = r; bestG = g; bestB = b;
      }
    }
    var peak  = Math.max(bestR, bestG, bestB);
    var boost = 220 / Math.max(peak, 1);
    return [
      Math.min(255, Math.round(bestR * boost)),
      Math.min(255, Math.round(bestG * boost)),
      Math.min(255, Math.round(bestB * boost))
    ];
  } catch(e) { return [232, 0, 26]; }
}

function toC(rgb, alpha) {
  if (alpha !== undefined) return 'rgba('+rgb[0]+','+rgb[1]+','+rgb[2]+','+alpha+')';
  return 'rgb('+rgb[0]+','+rgb[1]+','+rgb[2]+')';
}

function darkenC(rgb, t) {
  return [Math.round(rgb[0]*(1-t)), Math.round(rgb[1]*(1-t)), Math.round(rgb[2]*(1-t))];
}

function lightenC(rgb, t) {
  return [
    Math.round(rgb[0]+(255-rgb[0])*t),
    Math.round(rgb[1]+(255-rgb[1])*t),
    Math.round(rgb[2]+(255-rgb[2])*t)
  ];
}

// Make a warm cream tinted with an album color for the bg
function creamTint(rgb) {
  // Blend toward FFF0C0 (warm cream) keeping some album character
  var cream = [255, 240, 192];
  return [
    Math.round(rgb[0]*0.15 + cream[0]*0.85),
    Math.round(rgb[1]*0.15 + cream[1]*0.85),
    Math.round(rgb[2]*0.15 + cream[2]*0.85)
  ];
}

// ── Canvas helpers ─────────────────────────────────────────────

function fitC(ctx, text, maxW) {
  if (!text) return '';
  if (ctx.measureText(text).width <= maxW) return text;
  var lo = 0, hi = text.length;
  while (lo < hi - 1) {
    var mid = Math.floor((lo+hi)/2);
    ctx.measureText(text.substring(0,mid)+'…').width <= maxW ? (lo=mid) : (hi=mid);
  }
  return text.substring(0,lo)+'…';
}

function rrC(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x+r,y); ctx.lineTo(x+w-r,y); ctx.quadraticCurveTo(x+w,y,x+w,y+r);
  ctx.lineTo(x+w,y+h-r); ctx.quadraticCurveTo(x+w,y+h,x+w-r,y+h);
  ctx.lineTo(x+r,y+h); ctx.quadraticCurveTo(x,y+h,x,y+h-r);
  ctx.lineTo(x,y+r); ctx.quadraticCurveTo(x,y,x+r,y);
  ctx.closePath();
}

// ── Main ──────────────────────────────────────────────────────

function drawCard(d) {
  var canvas = document.getElementById('weekCanvas');
  var ctx    = canvas.getContext('2d');
  ctx.clearRect(0, 0, CW_CARD, CH_CARD);

  var CW  = CW_CARD;
  var CH  = CH_CARD;
  var PAD = PAD_CARD;

  // Sample vivid colors from each album's art
  var A = (d.artImages && d.artImages[0]) ? sampleVividColor(d.artImages[0]) : [232,0,26];
  var B = (d.artImages && d.artImages[1]) ? sampleVividColor(d.artImages[1]) : [196,149,106];
  var C = (d.artImages && d.artImages[2]) ? sampleVividColor(d.artImages[2]) : [232,201,106];

  // Darken A for depth effects
  var Ad  = darkenC(A, 0.35);
  var Adl = darkenC(A, 0.15);

  // Sepia band = blend of B and C, slightly muted
  var sepia = [
    Math.round((B[0]+C[0])/2 * 0.75 + 80),
    Math.round((B[1]+C[1])/2 * 0.75 + 60),
    Math.round((B[2]+C[2])/2 * 0.75 + 40)
  ];

  // Bottom cream = warm tint of B
  var cream = creamTint(B);

  // ── BACKGROUND ZONES ────────────────────────────────────────

  // Top zone: album 1 vivid color (0–540)
  ctx.fillStyle = toC(A);
  ctx.fillRect(0, 0, CW, 540);

  // Depth glow circles in top zone
  ctx.fillStyle = toC(Ad, 0.6);
  ctx.beginPath(); ctx.arc(CW*0.85, 100, 400, 0, Math.PI*2); ctx.fill();
  ctx.fillStyle = toC(lightenC(A, 0.25), 0.12);
  ctx.beginPath(); ctx.arc(CW*0.82, 80, 220, 0, Math.PI*2); ctx.fill();

  // Bottom zone: warm cream tinted with album 2 (540–1920)
  ctx.fillStyle = toC(cream);
  ctx.fillRect(0, 540, CW, CH-540);

  // Soft glow from album 2 in bottom zone
  var grad2 = ctx.createRadialGradient(160, 950, 0, 160, 950, 500);
  grad2.addColorStop(0, toC(B, 0.2));
  grad2.addColorStop(1, 'transparent');
  ctx.fillStyle = grad2;
  ctx.fillRect(0, 540, CW, CH-540);

  // Diagonal sepia band across the join (album 3 color bridge)
  ctx.fillStyle = toC(sepia);
  ctx.beginPath();
  ctx.moveTo(0, 490);
  ctx.lineTo(CW, 560);
  ctx.lineTo(CW, 600);
  ctx.lineTo(0, 534);
  ctx.closePath();
  ctx.fill();

  // ── ALBUM 1 ART — tilted, right side, large ─────────────────
  var artSz = 400;
  var artX  = CW - artSz + 60;
  var artY  = 100;

  ctx.save();
  ctx.translate(artX + artSz/2, artY + artSz/2);
  ctx.rotate(4 * Math.PI / 180);
  ctx.translate(-(artX + artSz/2), -(artY + artSz/2));

  // Art bg
  ctx.fillStyle = toC(Ad);
  ctx.fillRect(artX, artY, artSz, artSz);

  // Draw album art if available
  if (d.artImages && d.artImages[0]) {
    ctx.drawImage(d.artImages[0], artX, artY, artSz, artSz);
  } else {
    // Placeholder texture
    ctx.fillStyle = toC(A, 0.25);
    ctx.fillRect(artX, artY, artSz, artSz/2);
    var plGrid = ctx.createLinearGradient(artX, artY, artX+artSz, artY+artSz);
    plGrid.addColorStop(0, toC([255,255,255], 0.06));
    plGrid.addColorStop(1, 'transparent');
    ctx.fillStyle = plGrid;
    ctx.fillRect(artX, artY, artSz, artSz);
    // Grid lines
    for (var gl = 0; gl < 3; gl++) {
      ctx.strokeStyle = toC([255,255,255], 0.12);
      ctx.lineWidth = 0.8;
      ctx.beginPath(); ctx.moveTo(artX, artY+artSz*(gl+1)/4); ctx.lineTo(artX+artSz, artY+artSz*(gl+1)/4); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(artX+artSz*(gl+1)/4, artY); ctx.lineTo(artX+artSz*(gl+1)/4, artY+artSz); ctx.stroke();
    }
  }

  // Dark strip at bottom of art with album name
  ctx.fillStyle = 'rgba(0,0,0,0.55)';
  ctx.fillRect(artX, artY+artSz-60, artSz, 60);

  var r0 = d.top3 && d.top3[0];
  if (r0) {
    ctx.fillStyle = toC(A);
    ctx.font = '600 22px "DM Sans",sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(fitC(ctx, r0.albums.name.toUpperCase(), artSz-24), artX+artSz/2, artY+artSz-24);
    ctx.textAlign = 'left';
  }

  ctx.restore();

  // ── MASTHEAD ─────────────────────────────────────────────────
  ctx.fillStyle = 'rgba(255,255,255,0.42)';
  ctx.font = '300 22px "DM Sans",sans-serif';
  ctx.fillText('your personal', PAD, 50);

  ctx.fillStyle = '#ffffff';
  ctx.font = 'italic bold 72px Georgia,serif';
  ctx.fillText('Album', PAD, 118);
  var aw = ctx.measureText('Album').width;
  ctx.fillStyle = 'rgba(255,255,255,0.45)';
  ctx.font = 'bold 72px Georgia,serif';
  ctx.fillText('Rater', PAD+aw+16, 118);

  ctx.fillStyle = 'rgba(255,255,255,0.3)';
  ctx.fillRect(PAD, 128, 420, 2);

  // Date
  var months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  var s = d.startDate, eCopy = new Date(d.endDate);
  eCopy.setDate(eCopy.getDate()-1);
  var dateStr = months[s.getMonth()]+' '+s.getDate()+' – '+months[eCopy.getMonth()]+' '+eCopy.getDate()+', '+eCopy.getFullYear();
  ctx.fillStyle = 'rgba(255,255,255,0.32)';
  ctx.font = '500 22px "DM Sans",sans-serif';
  ctx.fillText(dateStr.toUpperCase(), PAD, 156);

  // ── SCORE ────────────────────────────────────────────────────
  var scoreStr = r0 ? String(r0.rating) : d.avgScore || '—';
  var scoreParts = scoreStr.split('.');

  // Ghost score
  ctx.fillStyle = 'rgba(255,255,255,0.05)';
  ctx.font = 'italic bold 380px Georgia,serif';
  ctx.fillText(scoreParts[0], 10, 530);

  // Real score integer
  ctx.fillStyle = 'rgba(255,255,255,0.95)';
  ctx.font = 'italic bold 300px Georgia,serif';
  ctx.fillText(scoreParts[0], PAD, 514);
  var intW = ctx.measureText(scoreParts[0]).width;

  // Decimal
  if (scoreParts[1]) {
    ctx.fillStyle = 'rgba(255,255,255,0.72)';
    ctx.font = 'italic bold 110px Georgia,serif';
    ctx.fillText('.'+scoreParts[1], PAD+intW+10, 440);
  }

  // /out of 10 — on its own line, no overlap
  ctx.fillStyle = 'rgba(255,255,255,0.28)';
  ctx.font = 'italic 28px Georgia,serif';
  ctx.fillText('out of 10', PAD+intW+18, 484);

  // Album label below score
  ctx.fillStyle = 'rgba(255,255,255,0.4)';
  ctx.font = '500 22px "DM Sans",sans-serif';
  var label1 = r0 ? (r0.albums.name.toUpperCase()+' · '+r0.albums.artist.toUpperCase()+' · ALBUM OF THE WEEK') : 'ALBUM OF THE WEEK';
  ctx.fillText(fitC(ctx, label1, CW-PAD*2), PAD, 548);

  // Sepia band label — albums 2 and 3
  var r1 = d.top3 && d.top3[1];
  var r2 = d.top3 && d.top3[2];
  ctx.fillStyle = 'rgba(255,255,255,0.8)';
  ctx.font = 'italic 26px Georgia,serif';
  var sepiaText = '';
  if (r1) sepiaText += '#2 '+r1.albums.name+' · '+r1.albums.artist+' · '+r1.rating;
  if (r1 && r2) sepiaText += '     ';
  if (r2) sepiaText += '#3 '+r2.albums.name+' · '+r2.albums.artist+' · '+r2.rating;
  ctx.fillText(fitC(ctx, sepiaText, CW-PAD*2), PAD, 586);

  // ── ALBUMS 2 & 3 CARDS ───────────────────────────────────────
  var cardY    = 620;
  var cardH    = 230;
  var cardGap  = 20;
  var card1W   = Math.floor((CW - PAD*2 - cardGap) / 2);
  var card2W   = CW - PAD*2 - cardGap - card1W;

  [r1, r2].forEach(function(r, ci) {
    if (!r) return;
    var cx       = PAD + ci*(card1W+cardGap);
    var cw       = ci === 0 ? card1W : card2W;
    var col      = ci === 0 ? B : C;
    var colLight = lightenC(col, 0.55);

    // White card
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(cx, cardY, cw, cardH);

    // Colored top stripe
    ctx.fillStyle = toC(col);
    ctx.fillRect(cx, cardY, cw, 6);

    // Album art
    var artSzS = 120;
    var artPad = 12;
    if (d.artImages && d.artImages[ci+1]) {
      ctx.save();
      rrC(ctx, cx+artPad, cardY+artPad+6, artSzS, artSzS, 4);
      ctx.clip();
      ctx.drawImage(d.artImages[ci+1], cx+artPad, cardY+artPad+6, artSzS, artSzS);
      ctx.restore();
    } else {
      ctx.fillStyle = toC(colLight);
      ctx.fillRect(cx+artPad, cardY+artPad+6, artSzS, artSzS);
      // Circle motif placeholder
      ctx.fillStyle = toC(col, 0.4);
      ctx.beginPath(); ctx.arc(cx+artPad+artSzS/2, cardY+artPad+6+artSzS/2, artSzS*0.35, 0, Math.PI*2); ctx.fill();
      ctx.fillStyle = toC(col, 0.6);
      ctx.beginPath(); ctx.arc(cx+artPad+artSzS/2, cardY+artPad+6+artSzS/2, artSzS*0.18, 0, Math.PI*2); ctx.fill();
    }

    // Rank badge on art
    ctx.fillStyle = toC(col);
    ctx.fillRect(cx+artPad, cardY+artPad+6, 44, 28);
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 18px "DM Sans",sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('#'+(ci+2), cx+artPad+22, cardY+artPad+24);
    ctx.textAlign = 'left';

    // Text — right of art
    var tx   = cx + artPad + artSzS + 16;
    var tmx  = cw - artSzS - artPad*2 - 16;
    var tyBase = cardY + artPad + 30;

    ctx.fillStyle = '#1a1208';
    ctx.font = 'bold 28px "DM Sans",sans-serif';
    ctx.fillText(fitC(ctx, r.albums.name, tmx), tx, tyBase);

    ctx.fillStyle = toC(col);
    ctx.font = '400 20px "DM Sans",sans-serif';
    ctx.fillText(fitC(ctx, r.albums.artist, tmx), tx, tyBase+32);

    ctx.fillStyle = 'rgba(90,60,30,0.5)';
    ctx.font = '400 18px "DM Sans",sans-serif';
    var year = r.albums.release_year || '';
    ctx.fillText(fitC(ctx, year, tmx), tx, tyBase+56);

    // Score — large, colored, no overlap with /10
    ctx.fillStyle = toC(col);
    ctx.font = 'italic bold 64px Georgia,serif';
    ctx.fillText(String(r.rating), cx+artPad, cardY+cardH-52);
    var sw = ctx.measureText(String(r.rating)).width;

    // /10 — right of score, vertically aligned, clear gap
    ctx.fillStyle = 'rgba(90,60,30,0.45)';
    ctx.font = '400 22px "DM Sans",sans-serif';
    ctx.fillText('/10', cx+artPad+sw+10, cardY+cardH-60);

    // Minutes + starred count — on their own line below score
    var minsVal = d.albumMinsMap ? (d.albumMinsMap[r.albums.name]||0) : 0;
    var songs = r.top_songs ? r.top_songs.length : 0;
    ctx.fillStyle = 'rgba(90,60,30,0.4)';
    ctx.font = '400 18px "DM Sans",sans-serif';
    ctx.fillText((minsVal>0?minsVal+'m · ':'')+songs+' starred', cx+artPad, cardY+cardH-24);

    // Starred songs strip at very bottom
    ctx.fillStyle = toC(col, 0.1);
    ctx.fillRect(cx, cardY+cardH-22, cw, 22);
    if (r.top_songs && r.top_songs.length > 0) {
      ctx.fillStyle = toC(col, 0.7);
      ctx.font = '400 17px "DM Sans",sans-serif';
      var songsStr = '★  '+r.top_songs.slice(0,3).join('  ·  ');
      ctx.fillText(fitC(ctx, songsStr, cw-24), cx+12, cardY+cardH-6);
    }
  });

  // ── HEAT MAP ─────────────────────────────────────────────────
  var hmY   = cardY + cardH + 36;
  var hmLabelH = 36;

  ctx.fillStyle = 'rgba(90,60,30,0.55)';
  ctx.font = '600 20px "DM Sans",sans-serif';
  ctx.fillText('LISTENING HEAT · THIS WEEK', PAD, hmY+20);

  // Day labels
  var days    = ['MON','TUE','WED','THU','FRI','SAT','SUN'];
  var hmBarW  = Math.floor((CW - PAD*2) / 7);
  var tileW   = hmBarW - 8;
  var tileH   = 32;
  var rowGap  = 10;
  var albums3 = [
    { r: d.top3&&d.top3[0], col: A, label: r0 ? fitC(ctx, r0.albums.artist, 160) : 'Album 1' },
    { r: d.top3&&d.top3[1], col: B, label: r1 ? fitC(ctx, r1.albums.artist, 160) : 'Album 2' },
    { r: d.top3&&d.top3[2], col: C, label: r2 ? fitC(ctx, r2.albums.artist, 160) : 'Album 3' }
  ];

  ctx.fillStyle = 'rgba(90,60,30,0.4)';
  ctx.font = '400 18px "DM Sans",sans-serif';
  ctx.textAlign = 'center';
  days.forEach(function(day, di) {
    ctx.fillText(day, PAD + di*hmBarW + tileW/2 + 4, hmY+hmLabelH);
  });
  ctx.textAlign = 'left';

  // Heat intensities — simulated from byDate
  var dates = Object.keys(d.byDate||{}).sort();

  albums3.forEach(function(entry, ai) {
    var rowY = hmY + hmLabelH + 10 + ai*(tileH+rowGap);

    // Artist label
    ctx.fillStyle = toC(entry.col);
    ctx.font = '600 18px "DM Sans",sans-serif';
    ctx.fillText(entry.label, PAD, rowY+tileH*0.7);

    // Tiles — one per day
    var maxVal = 1;
    dates.forEach(function(dt) {
      var v = (d.byDate[dt] && entry.r && d.byDate[dt][entry.r.albums.name]) || 0;
      if (v > maxVal) maxVal = v;
    });

    days.forEach(function(day, di) {
      var dt  = dates[di] || null;
      var val = dt && entry.r ? ((d.byDate[dt]&&d.byDate[dt][entry.r.albums.name])||0) : 0;
      var opacity = maxVal > 0 ? Math.max(0.08, val/maxVal*0.9) : 0.08;
      var tileX = PAD + di*hmBarW + 4;

      ctx.fillStyle = toC(entry.col, opacity);
      rrC(ctx, tileX, rowY, tileW, tileH, 4);
      ctx.fill();
    });
  });

  // ── SETLIST ───────────────────────────────────────────────────
  var slY = hmY + hmLabelH + 10 + 3*(tileH+rowGap) + 40;
  var divY = slY - 16;

  ctx.fillStyle = toC(B, 0.35);
  ctx.fillRect(PAD, divY, CW-PAD*2, 1);

  ctx.fillStyle = 'rgba(90,60,30,0.55)';
  ctx.font = '600 20px "DM Sans",sans-serif';
  ctx.fillText('STARRED THIS WEEK', PAD, slY+4);

  var totalStarred = d.starredSongs ? d.starredSongs.length : 0;
  ctx.fillStyle = 'rgba(90,60,30,0.35)';
  ctx.font = '400 18px "DM Sans",sans-serif';
  ctx.textAlign = 'right';
  ctx.fillText(totalStarred+' songs', CW-PAD, slY+4);
  ctx.textAlign = 'left';

  // Album color lookup by album name
  var colorByAlbum = {};
  if (r0) colorByAlbum[r0.albums.name] = A;
  if (r1) colorByAlbum[r1.albums.name] = B;
  if (r2) colorByAlbum[r2.albums.name] = C;

  var rowH_sl = 34;
  var maxRows = Math.floor((1180 - (slY+20)) / rowH_sl);
  var songs   = d.starredSongs || [];

  songs.slice(0, maxRows).forEach(function(sg, si) {
    var ry    = slY + 20 + si*rowH_sl;
    if (ry + rowH_sl > 1180) return;
    var col   = colorByAlbum[sg.album] || A;
    var even  = si%2 === 0;

    // Alternating tint row
    ctx.fillStyle = toC(col, even ? 0.07 : 0.04);
    ctx.fillRect(PAD, ry, CW-PAD*2, rowH_sl);

    // Track number
    ctx.fillStyle = toC(col, 0.75);
    ctx.font = 'bold 20px "DM Sans",sans-serif';
    ctx.fillText(String(si+1).padStart(2,'0'), PAD, ry+rowH_sl*0.72);

    // Song name
    ctx.fillStyle = '#1a1208';
    ctx.font = '500 22px "DM Sans",sans-serif';
    ctx.fillText(fitC(ctx, sg.song, 520), PAD+60, ry+rowH_sl*0.72);

    // Artist · album — right-ish
    ctx.fillStyle = 'rgba(90,60,30,0.5)';
    ctx.font = '400 18px "DM Sans",sans-serif';
    ctx.fillText(fitC(ctx, sg.artist, 260), PAD+600, ry+rowH_sl*0.72);

    // Star
    ctx.fillStyle = toC(col, 0.85);
    ctx.font = 'bold 20px "DM Sans",sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText('★', CW-PAD, ry+rowH_sl*0.72);
    ctx.textAlign = 'left';
  });

  // ── FOOTER BAND — stats live here ────────────────────────────
  var footerY = 1500;
  var footerH = CH - footerY;

  ctx.fillStyle = toC(A);
  ctx.fillRect(0, footerY, CW, footerH);

  // Glow in footer
  var fg = ctx.createRadialGradient(CW*0.8, footerY+footerH*0.5, 0, CW*0.8, footerY+footerH*0.5, 500);
  fg.addColorStop(0, toC(lightenC(A,0.3), 0.25));
  fg.addColorStop(1, 'transparent');
  ctx.fillStyle = fg;
  ctx.fillRect(0, footerY, CW, footerH);

  // 4 stats — centered in 4 equal columns, no overlap
  var statsData = [
    { val: String(d.totalRated||0),   label: 'ALBUMS RATED' },
    { val: String(d.totalStarred||0), label: 'SONGS STARRED' },
    { val: Math.round(d.totalMins||0)+'m', label: 'LISTENED' },
    { val: String(d.avgScore||'—'),   label: 'AVG SCORE' }
  ];
  var colW_st = CW / 4;
  var numY    = footerY + Math.round(footerH * 0.45);
  var lblY    = footerY + Math.round(footerH * 0.62);

  statsData.forEach(function(st, si) {
    var cx_st = colW_st*si + colW_st/2;
    ctx.fillStyle = '#ffffff';
    ctx.font = 'italic bold 72px Georgia,serif';
    ctx.textAlign = 'center';
    ctx.fillText(st.val, cx_st, numY);
    ctx.fillStyle = 'rgba(255,255,255,0.45)';
    ctx.font = '500 20px "DM Sans",sans-serif';
    ctx.fillText(st.label, cx_st, lblY);
  });
  ctx.textAlign = 'left';

  // Wordmark
  ctx.fillStyle = 'rgba(255,255,255,0.28)';
  ctx.font = 'italic 22px Georgia,serif';
  ctx.textAlign = 'center';
  ctx.fillText('Album Rater · sillymcwilly1.github.io/2026-Albums', CW/2, footerY+footerH-36);
  ctx.textAlign = 'left';

} // ← end drawCard
