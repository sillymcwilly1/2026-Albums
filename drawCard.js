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

  // ── ZONE 1: MASTHEAD (0–230) ───────────────────────────────
  // Top 60px = Instagram UI safe zone (time, battery, camera icon)
  // Dark band sits behind it so chrome doesn't clash with content
  ctx.fillStyle = toRgbC(darkenC(A, 0.88));
  ctx.fillRect(0, 0, CW, 60);

  // Subtitle + date — sit in safe zone, very subtle
  ctx.fillStyle = toRgbC(A, 0.35);
  ctx.font = 'italic 18px "DM Sans",sans-serif';
  ctx.fillText('week in review', PAD+4, 42);

  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const eDateCopy = new Date(d.endDate); eDateCopy.setDate(eDateCopy.getDate()-1);
  const dateStr = months[d.startDate.getMonth()]+' '+d.startDate.getDate()+' – '+months[eDateCopy.getMonth()]+' '+eDateCopy.getDate()+', '+eDateCopy.getFullYear();
  ctx.textAlign = 'right';
  ctx.fillStyle = toRgbC(A, 0.3);
  ctx.font = '400 18px "DM Sans",sans-serif';
  ctx.fillText(dateStr.toUpperCase(), CW-PAD, 42);
  ctx.textAlign = 'left';

  // Wordmark — below safe zone, 62px font (was 84px) so it fits with breathing room
  ctx.fillStyle = '#ffffff';
  ctx.font = 'italic bold 62px Georgia,serif';
  ctx.fillText('Album ', PAD, 138);
  const awW = ctx.measureText('Album ').width;
  ctx.fillStyle = toRgbC(A);
  ctx.font = 'bold 62px Georgia,serif';
  ctx.fillText('Rater', PAD+awW, 138);

  hRuleC(ctx, 158, PAD, CW-PAD, '#ffffff', 0.12);

  // ── ZONE 2: HERO ALBUM #1 (158–560) ───────────────────────
  const artSz = 310;
  const artX = PAD, artY = 174; // 16px below rule — clear of wordmark

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
  // Stats band: y=760–870 = 110px. Label at 785, number at 848 = vertically centered.
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
    ctx.fillText(st.label, sx, 785);
    ctx.fillStyle=toRgbC(st.c); ctx.font='italic bold 56px Georgia,serif';
    ctx.fillText(st.val, sx, 848);
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
    // No cutoff guard — all 4 rows always render regardless of count
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

    // Track — always drawn
    ctx.fillStyle = '#1e1c18';
    rrectC(ctx, barX, rowY, barAreaW, rowH, rowH/2); ctx.fill();

    // Empty bucket: show "0" so the row is always meaningful
    if (prior === 0 && wk === 0) {
      ctx.fillStyle = '#3a3830';
      ctx.font = '400 20px "DM Sans",sans-serif';
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

  // ── ZONE 7: PLAY TIMELINE (1470–1730) ────────────────────
  ctx.fillStyle = '#8a8070';
  ctx.font = '600 20px "DM Sans",sans-serif';
  ctx.fillText('PLAY TIMELINE', PAD, 1510);

  // Hard bounds — chart can NEVER draw outside these
  const cX = PAD+64;
  const cTop = 1528;
  const cBot = 1700;
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

  hRuleC(ctx, 1730, PAD, CW-PAD, '#ffffff', 0.08);

  // ── ZONE 8: FOOTER (1730–1920) — clean dark close ─────────
  ctx.fillStyle = toRgbC(A, 0.12);
  ctx.beginPath(); ctx.arc(CW/2, 1920, 520, 0, Math.PI*2); ctx.fill();
  ctx.fillStyle = toRgbC(B, 0.08);
  ctx.beginPath(); ctx.arc(180, 1920, 340, 0, Math.PI*2); ctx.fill();
  ctx.fillStyle = toRgbC(C, 0.06);
  ctx.beginPath(); ctx.arc(900, 1920, 300, 0, Math.PI*2); ctx.fill();

  // Bottom edge — vivid color stripe only
  ctx.fillStyle = toRgbC(A);
  ctx.fillRect(0, CH-6, CW, 6);
} // ← end drawCard
