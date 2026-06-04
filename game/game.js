/* =============================================================
   Mini Metropolis — a tiny SimCity-style city builder
   Pure vanilla JS + Canvas. No dependencies, no build step.
   Open index.html in any browser to play.
   ============================================================= */
'use strict';

document.addEventListener('DOMContentLoaded', main);

function main() {
  /* ---------- Config ---------- */
  const GRID = 44;          // tiles per side
  let   TILE = 18;          // px per tile (logical) — recomputed to fit by fitCanvas()
  const MAX_LVL = 5;        // building density levels

  // Tile type ids
  const T = {
    GRASS: 0, ROAD: 1, RES: 2, COM: 3, IND: 4,
    POWER: 5, PARK: 6, POLICE: 7, FIRE: 8, WATER: 9, TREE: 10,
  };

  // Tools (also drives the palette UI). cost = build cost.
  const TOOLS = [
    { id: 'road',   type: T.ROAD,   name: 'Road',         ico: '🛣️', cost: 10,   key: '1' },
    { id: 'res',    type: T.RES,    name: 'Residential',  ico: '🏠', cost: 50,   key: '2' },
    { id: 'com',    type: T.COM,    name: 'Commercial',   ico: '🏬', cost: 60,   key: '3' },
    { id: 'ind',    type: T.IND,    name: 'Industrial',   ico: '🏭', cost: 60,   key: '4' },
    { id: 'power',  type: T.POWER,  name: 'Power Plant',  ico: '⚡', cost: 1800, key: '5' },
    { id: 'park',   type: T.PARK,   name: 'Park',         ico: '🌳', cost: 30,   key: '6' },
    { id: 'police', type: T.POLICE, name: 'Police',       ico: '🚓', cost: 500,  key: '7' },
    { id: 'fire',   type: T.FIRE,   name: 'Fire Station', ico: '🚒', cost: 500,  key: '8' },
    { id: 'bull',   type: T.GRASS,  name: 'Bulldoze',     ico: '⛏️', cost: 0,    key: '9' },
  ];

  // Per-tile monthly upkeep
  const UPKEEP = { [T.ROAD]: 1, [T.POWER]: 90, [T.POLICE]: 90, [T.FIRE]: 90, [T.PARK]: 2 };
  // Original build cost per tile type — bulldozing refunds half (a recovery lever when broke)
  const BUILD_COST = { [T.ROAD]: 10, [T.RES]: 50, [T.COM]: 60, [T.IND]: 60, [T.POWER]: 1800, [T.PARK]: 30, [T.POLICE]: 500, [T.FIRE]: 500 };

  const PLANT_CAPACITY = 130; // consumer tiles a single power plant can feed
  const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const SPEED_MS = { 0: Infinity, 1: 900, 2: 350, 3: 120 };
  const SAVE_KEY = 'miniMetropolisSave_v1';

  /* ---------- State ---------- */
  const N = GRID * GRID;
  let map;            // Array<{t,lvl,pwr}>
  let money, tax, month, speed, lastNet;
  let tool = TOOLS[0];
  let approval = 50;
  // demand (people units) and aggregate stats from last tick
  let demand = { r: 60, c: 0, i: 0 };
  let stats = { pop: 0, jobs: 0, comJobs: 0, indJobs: 0,
                resN: 0, comN: 0, indN: 0, roads: 0, plants: 0,
                police: 0, fire: 0, parks: 0, poweredZones: 0, totalZones: 0 };

  // influence maps (rebuilt each tick)
  let parkInf, policeCov, fireCov, landVal;

  /* ---------- DOM ---------- */
  const canvas = document.getElementById('city');
  const ctx = canvas.getContext('2d');
  const tooltip = document.getElementById('tooltip');
  const hintEl = document.getElementById('hint');

  /* ---------- Helpers ---------- */
  const idx = (c, r) => r * GRID + c;
  const inB = (c, r) => c >= 0 && r >= 0 && c < GRID && r < GRID;
  const isZone = (t) => t === T.RES || t === T.COM || t === T.IND;
  const conducts = (t) => t !== T.GRASS && t !== T.WATER && t !== T.TREE; // power flows through built tiles
  const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
  const fmtMoney = (v) => (v < 0 ? '-$' : '$') + Math.abs(Math.round(v)).toLocaleString('en-US');

  /* ---------- Camera + isometric projection (zoom & pan) ----------
     The city is drawn into the buffer in "buffer px" via bX/bY (isometric).
     The camera shows a slice of that buffer scaled by `scrScale()` and offset
     by cam.x/cam.y (screen px of the buffer's top-left). */
  const cam = { zoom: 1, x: 0, y: 0 };
  let baseTW = 24, TW = 48, TH = 24, ISO_OX = 0, ISO_OY = 0, maxH = 100;
  let viewW = 820, viewH = 820, DPR = 1, Z_MAX = 3, bufW = 0, bufH = 0;

  const scrScale = () => (baseTW * cam.zoom) / TW;   // buffer px -> screen px
  const scrTW    = () => baseTW * cam.zoom;          // on-screen tile width (sprite size unit)

  // buffer-px projection of a continuous tile (fc,fr) at elevation h (buffer px)
  const bX = (fc, fr)    => ISO_OX + (fc - fr) * (TW / 2);
  const bY = (fc, fr, h) => ISO_OY + (fc + fr) * (TH / 2) - (h || 0);

  // continuous tile (fc,fr,elevation) -> screen px
  function tileToScreen(fc, fr, h) {
    const S = scrScale();
    return { x: cam.x + bX(fc, fr) * S, y: cam.y + bY(fc, fr, h) * S };
  }
  // screen px -> continuous tile coords (on the ground plane)
  function screenToTile(sx, sy) {
    const S = scrScale();
    const px = (sx - cam.x) / S, py = (sy - cam.y) / S;
    const a = (px - ISO_OX) * 2 / TW;   // fc - fr
    const b = (py - ISO_OY) * 2 / TH;   // fc + fr
    return { fc: (a + b) / 2, fr: (b - a) / 2 };
  }

  function clampCam() {
    cam.zoom = clamp(cam.zoom, 1, Z_MAX);
    const S = scrScale(), mapW = bufW * S, mapH = bufH * S;
    cam.x = mapW <= viewW ? (viewW - mapW) / 2 : clamp(cam.x, viewW - mapW, 0);
    cam.y = mapH <= viewH ? (viewH - mapH) / 2 : clamp(cam.y, viewH - mapH, 0);
  }
  function resetView() { cam.zoom = 1; clampCam(); }
  function zoomBy(f) {                          // zoom toward the view centre
    const cx = viewW / 2, cy = viewH / 2, S0 = scrScale();
    const bx = (cx - cam.x) / S0, by = (cy - cam.y) / S0;
    cam.zoom = clamp(cam.zoom * f, 1, Z_MAX);
    const S1 = scrScale();
    cam.x = cx - bx * S1; cam.y = cy - by * S1; clampCam();
  }

  /* ---------- Map generation ---------- */
  function genMap() {
    map = new Array(N);
    for (let i = 0; i < N; i++) map[i] = { t: T.GRASS, lvl: 0, pwr: false };

    // A meandering river using a couple of sine waves
    const phase = Math.random() * Math.PI * 2;
    const phase2 = Math.random() * Math.PI * 2;
    for (let r = 0; r < GRID; r++) {
      const center = GRID * 0.5
        + Math.sin(r / 6 + phase) * 5
        + Math.sin(r / 13 + phase2) * 4;
      const width = 1.4 + Math.sin(r / 9) * 0.6;
      for (let c = 0; c < GRID; c++) {
        if (Math.abs(c - center) < width) map[idx(c, r)].t = T.WATER;
      }
    }
    // Scatter some trees on grass
    for (let i = 0; i < N; i++) {
      if (map[i].t === T.GRASS && Math.random() < 0.05) map[i].t = T.TREE;
    }
  }

  function newCity() {
    genMap();
    undoStack.length = 0; curBatch = null;
    money = 20000;
    tax = 7;
    month = 0;       // Jan 1900
    speed = 1;
    lastNet = 0;
    approval = 50;
    demand = { r: 60, c: 0, i: 0 };
    document.getElementById('tax-slider').value = tax;
    document.getElementById('tax-val').textContent = tax;
    setSpeed(1);
    fitCanvas();
    fullStatsPass();
    updateUI();
    setHint('Welcome, Mayor! Lay some roads, drop a power plant, then zone Residential. ❔ Help explains the rest.');
  }

  /* ---------- Canvas sizing (full-resolution, retina-crisp) ----------
     The visible canvas fills the whole stage; the camera decides which slice of
     the map is shown. The city is pre-rendered into an offscreen buffer at a
     supersampled tile size (`TILE`) so it stays crisp as you zoom in. */
  function fitCanvas() {
    const stage = document.getElementById('stage');
    viewW = stage.clientWidth  || 820;
    viewH = stage.clientHeight || 820;
    DPR = Math.max(1, Math.min(3, window.devicePixelRatio || 1));

    Z_MAX = 3.2;
    // tile width that fits the whole iso diamond both ways at zoom 1
    baseTW = Math.max(10, Math.floor(Math.min(viewW / GRID, viewH / (GRID / 2 + 5))));

    // buffer (supersampled) iso tile dims, capped so the backing canvas isn't huge
    TW = Math.min(baseTW * 2, Math.floor(4000 / DPR / GRID));
    TH = TW / 2;
    maxH   = TW * 2.6;                 // tallest tower's elevation (buffer px)
    ISO_OX = GRID * TW / 2;            // shift so the leftmost tile sits at x=0
    ISO_OY = maxH + TH;               // headroom above the back row for tall buildings
    bufW   = GRID * TW;               // buffer css width
    bufH   = ISO_OY + GRID * TH + TH; // buffer css height (ground span + bottom margin)

    // visible canvas fills the viewport
    canvas.style.width  = viewW + 'px';
    canvas.style.height = viewH + 'px';
    canvas.width  = Math.round(viewW * DPR);
    canvas.height = Math.round(viewH * DPR);
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);

    scene.width  = Math.round(bufW * DPR);
    scene.height = Math.round(bufH * DPR);
    sctx.setTransform(DPR, 0, 0, DPR, 0, 0);

    clampCam();
    markDirty();
  }

  /* ---------- Simulation: one month tick ---------- */
  function tick() {
    buildInfluence();
    propagatePower();
    computeLandValue();
    grow();              // uses demand from previous tick
    computeStats();
    computeDemand();
    economy();
    month++;
    updateUI();
    markDirty();   // buildings may have grown / power changed
  }

  // Park/police/fire coverage stamps
  function buildInfluence() {
    parkInf = new Float32Array(N);
    policeCov = new Float32Array(N);
    fireCov = new Float32Array(N);
    const stamp = (arr, c0, r0, rad, peak) => {
      for (let r = r0 - rad; r <= r0 + rad; r++) {
        for (let c = c0 - rad; c <= c0 + rad; c++) {
          if (!inB(c, r)) continue;
          const d = Math.abs(c - c0) + Math.abs(r - r0);
          if (d > rad) continue;
          const v = peak * (1 - d / (rad + 1));
          const i = idx(c, r);
          if (v > arr[i]) arr[i] = v;
        }
      }
    };
    for (let i = 0; i < N; i++) {
      const t = map[i].t;
      if (t === T.PARK)   stamp(parkInf,   i % GRID, (i / GRID) | 0, 4, 1);
      if (t === T.POLICE) stamp(policeCov, i % GRID, (i / GRID) | 0, 7, 1);
      if (t === T.FIRE)   stamp(fireCov,   i % GRID, (i / GRID) | 0, 6, 1);
    }
  }

  // Flood power from each plant through connected built tiles, up to capacity
  function propagatePower() {
    for (let i = 0; i < N; i++) map[i].pwr = false;
    let capacity = 0;
    const queue = [];
    const seen = new Uint8Array(N);
    for (let i = 0; i < N; i++) {
      if (map[i].t === T.POWER) { queue.push(i); seen[i] = 1; capacity += PLANT_CAPACITY; }
    }
    let consumed = 0;
    while (queue.length) {
      const i = queue.shift();
      const t = map[i].t;
      // consumers draw capacity; roads/parks/plant conduct for free
      const isConsumer = isZone(t) || t === T.POLICE || t === T.FIRE;
      if (isConsumer) {
        if (consumed < capacity) { map[i].pwr = true; consumed++; }
        // if over capacity: still conducts, just stays unpowered (brownout)
      } else {
        map[i].pwr = true; // road/park/plant powered
      }
      const c = i % GRID, r = (i / GRID) | 0;
      const nb = [[c+1,r],[c-1,r],[c,r+1],[c,r-1]];
      for (const [nc, nr] of nb) {
        if (!inB(nc, nr)) continue;
        const j = idx(nc, nr);
        if (!seen[j] && conducts(map[j].t)) { seen[j] = 1; queue.push(j); }
      }
    }
  }

  function computeLandValue() {
    landVal = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      let v = 0.32;
      v += parkInf[i] * 0.22;
      v += policeCov[i] * 0.12;
      v += fireCov[i] * 0.06;
      if (map[i].pwr) v += 0.08;
      // crime pressure: dense zones with no police lose value
      if (isZone(map[i].t) && map[i].lvl >= 3 && policeCov[i] < 0.2) v -= 0.18;
      landVal[i] = clamp(v, 0.05, 1);
    }
  }

  function hasRoadNear(i) {
    const c0 = i % GRID, r0 = (i / GRID) | 0, rad = 3;
    for (let r = r0 - rad; r <= r0 + rad; r++) {
      for (let c = c0 - rad; c <= c0 + rad; c++) {
        if (!inB(c, r)) continue;
        if (Math.abs(c - c0) + Math.abs(r - r0) > rad) continue;
        if (map[idx(c, r)].t === T.ROAD) return true;
      }
    }
    return false;
  }

  // Zones grow / shrink based on power, road access and demand sign
  function grow() {
    if (money < -2000) return; // city in crisis — development freezes
    for (let i = 0; i < N; i++) {
      const tile = map[i];
      if (!isZone(tile.t)) continue;
      const dem = tile.t === T.RES ? demand.r : tile.t === T.COM ? demand.c : demand.i;
      const serviced = tile.pwr && hasRoadNear(i);

      if (!serviced) {
        // decay when power/road is missing
        if (tile.lvl > 0 && Math.random() < 0.25) tile.lvl--;
        continue;
      }
      if (dem > 5) {
        const pressure = clamp(dem / 220, 0, 1);
        const chance = (0.05 + pressure * 0.35) * (0.5 + landVal[i]);
        if (tile.lvl < MAX_LVL && Math.random() < chance) tile.lvl++;
      } else if (dem < -25) {
        // oversupply — slow abandonment
        if (tile.lvl > 0 && Math.random() < 0.08) tile.lvl--;
      }
    }
  }

  function computeStats() {
    const s = { pop: 0, jobs: 0, comJobs: 0, indJobs: 0,
                resN: 0, comN: 0, indN: 0, roads: 0, plants: 0,
                police: 0, fire: 0, parks: 0, poweredZones: 0, totalZones: 0 };
    for (let i = 0; i < N; i++) {
      const tile = map[i], t = tile.t, lv = landVal[i];
      switch (t) {
        case T.RES:
          s.resN++; s.totalZones++; if (tile.pwr) s.poweredZones++;
          s.pop += tile.lvl * 18 * (0.55 + 0.45 * lv);
          break;
        case T.COM:
          s.comN++; s.totalZones++; if (tile.pwr) s.poweredZones++;
          s.comJobs += tile.lvl * 9 * (0.55 + 0.45 * lv);
          break;
        case T.IND:
          s.indN++; s.totalZones++; if (tile.pwr) s.poweredZones++;
          s.indJobs += tile.lvl * 11 * (0.55 + 0.45 * lv);
          break;
        case T.ROAD:   s.roads++; break;
        case T.POWER:  s.plants++; break;
        case T.POLICE: s.police++; break;
        case T.FIRE:   s.fire++; break;
        case T.PARK:   s.parks++; break;
      }
    }
    s.pop = Math.round(s.pop);
    s.comJobs = Math.round(s.comJobs);
    s.indJobs = Math.round(s.indJobs);
    s.jobs = s.comJobs + s.indJobs;
    stats = s;
  }

  function computeDemand() {
    const { pop, jobs, comJobs, indJobs } = stats;
    // Classic self-balancing loop, in "people" units.
    demand.r = jobs * 1.5 - pop + 55;        // jobs available -> housing wanted
    demand.c = pop * 0.30 - comJobs;         // people need shops
    demand.i = pop * 0.22 - indJobs;         // people/exports need industry
  }

  function economy() {
    const income = (stats.pop * 0.85 + stats.comJobs * 1.0 + stats.indJobs * 0.9) * (tax / 100);
    let upkeep = 0;
    upkeep += stats.roads * UPKEEP[T.ROAD];
    upkeep += stats.plants * UPKEEP[T.POWER];
    upkeep += stats.police * UPKEEP[T.POLICE];
    upkeep += stats.fire * UPKEEP[T.FIRE];
    upkeep += stats.parks * UPKEEP[T.PARK];
    lastNet = Math.round(income - upkeep);
    money += lastNet;

    // Approval
    const poweredRatio = stats.totalZones ? stats.poweredZones / stats.totalZones : 1;
    const coverRatio = stats.totalZones
      ? clamp((stats.police + stats.fire) * 60 / stats.totalZones, 0, 1) : 1;
    let a = 50;
    a += poweredRatio * 22;
    a += coverRatio * 12;
    a -= (tax - 7) * 2;
    a += money > 0 ? 6 : -18;
    a += (demand.r > 0 || demand.c > 0 || demand.i > 0) ? 4 : -6;
    approval = Math.round(clamp(a, 0, 100));
  }

  // Run a couple of silent passes so a freshly loaded city has sane numbers
  function fullStatsPass() {
    buildInfluence(); propagatePower(); computeLandValue();
    computeStats(); computeDemand();
  }

  /* ---------- Rendering ----------
     The city is drawn once into an offscreen buffer (`scene`) whenever the
     map changes (`dirty`), then blitted each frame. This lets us pack in lots
     of per-tile detail — gradients, shadows, lit windows — without paying for
     it 60×/second. Only the hover cursor is redrawn live on top. */
  const scene = document.createElement('canvas');   // offscreen city buffer
  const sctx  = scene.getContext('2d');
  let dirty = true;
  let hoverIdx = -1;
  const markDirty = () => { dirty = true; };

  // nudge a #rrggbb colour lighter/darker by `amt` (-255..255)
  function shade(hex, amt) {
    const n = parseInt(hex.slice(1), 16);
    const R = clamp(((n >> 16) & 255) + amt, 0, 255);
    const G = clamp(((n >> 8) & 255) + amt, 0, 255);
    const B = clamp((n & 255) + amt, 0, 255);
    return 'rgb(' + R + ',' + G + ',' + B + ')';
  }

  // build a rounded-rect path (caller fills/strokes)
  function roundRect(g, x, y, w, h, rad) {
    const rr = Math.min(rad, w / 2, h / 2);
    g.beginPath();
    g.moveTo(x + rr, y);
    g.arcTo(x + w, y,     x + w, y + h, rr);
    g.arcTo(x + w, y + h, x,     y + h, rr);
    g.arcTo(x,     y + h, x,     y,     rr);
    g.arcTo(x,     y,     x + w, y,     rr);
    g.closePath();
  }

  // Per-frame: blit the city buffer through the camera, then live agents + hover.
  function render() {
    if (dirty) { renderScene(); dirty = false; }
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const S = scrScale();
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(scene, 0, 0, scene.width, scene.height,
                  cam.x * DPR, cam.y * DPR, bufW * S * DPR, bufH * S * DPR);
    ctx.restore();
    drawHover();       // tile highlight on the ground, BENEATH the buildings (so it doesn't slice them)
    drawTallLayer();   // 3D objects + agents, depth-sorted, on top
  }

  // path the diamond footprint of tile (c,r), inset by `ins` tiles, at elevation h
  function diamond(g, c, r, ins, h) {
    const a = c + ins, b = c + 1 - ins, p = r + ins, q = r + 1 - ins;
    g.beginPath();
    g.moveTo(bX(a, p), bY(a, p, h));   // north / top
    g.lineTo(bX(b, p), bY(b, p, h));   // east  / right
    g.lineTo(bX(b, q), bY(b, q, h));   // south / bottom
    g.lineTo(bX(a, q), bY(a, q, h));   // west  / left
    g.closePath();
  }

  // Only the GROUND is cached in the buffer (re-rendered when the map changes).
  // The 3D objects + agents are drawn live & depth-sorted each frame by
  // drawTallLayer(), so buildings correctly occlude the people behind them.
  function renderScene() {
    sctx.clearRect(0, 0, bufW, bufH);
    rebuildNetwork();   // refresh road list, lampposts, agent counts
    for (let r = 0; r < GRID; r++)
      for (let c = 0; c < GRID; c++)
        drawGroundIso(c, r, map[idx(c, r)]);
  }

  function drawGroundIso(c, r, tile) {
    const t = tile.t, cx = bX(c + 0.5, r + 0.5), cy = bY(c + 0.5, r + 0.5);
    if (t === T.WATER) {
      sctx.fillStyle = '#1f4f74'; diamond(sctx, c, r, -0.02, 0); sctx.fill();
      sctx.fillStyle = 'rgba(255,255,255,0.06)'; diamond(sctx, c, r, 0.34, 0); sctx.fill();
      return;
    }
    // grass base (slight per-tile variation, tiny overlap to hide seams)
    sctx.fillStyle = ['#3f5527', '#43592b', '#39501f'][(c * 3 + r * 7) % 3];
    diamond(sctx, c, r, -0.03, 0); sctx.fill();

    if (t === T.ROAD) { drawRoadIso(c, r); return; }
    if (t === T.PARK) {
      sctx.fillStyle = '#2f6b2a'; diamond(sctx, c, r, 0.12, 0); sctx.fill();
      sctx.fillStyle = '#3e8a33'; sctx.beginPath(); sctx.arc(cx, cy - TH * 0.1, TW * 0.12, 0, 7); sctx.fill();
      sctx.fillStyle = '#4c9b3d'; sctx.beginPath(); sctx.arc(cx + TW * 0.14, cy + TH * 0.1, TW * 0.09, 0, 7); sctx.fill();
      return;
    }
    if (isZone(t) && tile.lvl === 0) {                 // zoned but undeveloped
      const P = ZONE_PAL[t];
      sctx.fillStyle = P.empty; diamond(sctx, c, r, 0.14, 0); sctx.fill();
      sctx.strokeStyle = P.edge; sctx.lineWidth = Math.max(1, TW * 0.03);
      diamond(sctx, c, r, 0.16, 0); sctx.stroke();
      sctx.fillStyle = 'rgba(255,255,255,0.4)';
      sctx.font = '600 ' + (TW * 0.32) + 'px -apple-system, sans-serif';
      sctx.textAlign = 'center'; sctx.textBaseline = 'middle';
      sctx.fillText(P.letter, cx, cy - TH * 0.12);
    }
  }

  function drawRoadIso(c, r) {
    const isR = (cc, rr) => inB(cc, rr) && map[idx(cc, rr)].t === T.ROAD;
    sctx.fillStyle = '#3c4047'; diamond(sctx, c, r, 0.0, 0); sctx.fill();
    sctx.strokeStyle = 'rgba(232,206,92,0.8)';
    sctx.lineWidth = Math.max(1, TW * 0.035);
    sctx.setLineDash([TW * 0.1, TW * 0.12]);
    const cx = bX(c + 0.5, r + 0.5), cy = bY(c + 0.5, r + 0.5);
    const seg = (fc, fr) => { sctx.beginPath(); sctx.moveTo(cx, cy); sctx.lineTo(bX(fc, fr), bY(fc, fr)); sctx.stroke(); };
    if (isR(c, r - 1)) seg(c + 0.5, r);
    if (isR(c, r + 1)) seg(c + 0.5, r + 1);
    if (isR(c - 1, r)) seg(c, r + 0.5);
    if (isR(c + 1, r)) seg(c + 1, r + 0.5);
    sctx.setLineDash([]);
  }

  function drawTreeIso(c, r) {
    const x = bX(c + 0.5, r + 0.5), gy = bY(c + 0.5, r + 0.5), R = TW * 0.26;
    ctx.fillStyle = 'rgba(0,0,0,0.2)';
    ctx.beginPath(); ctx.ellipse(x, gy, R * 0.9, R * 0.45, 0, 0, 7); ctx.fill();
    ctx.fillStyle = '#5b3d22'; ctx.fillRect(x - TW * 0.03, gy - TH * 0.62, TW * 0.06, TH * 0.62);
    ctx.fillStyle = '#274d1c'; ctx.beginPath(); ctx.arc(x, gy - TH * 0.72, R, 0, 7); ctx.fill();
    ctx.fillStyle = '#356b27'; ctx.beginPath(); ctx.arc(x - R * 0.3, gy - TH * 0.92, R * 0.7, 0, 7); ctx.fill();
    ctx.fillStyle = '#4f8f37'; ctx.beginPath(); ctx.arc(x - R * 0.42, gy - TH * 1.08, R * 0.42, 0, 7); ctx.fill();
  }

  function drawPoleIso(c, r) {
    const p = poleByTile[idx(c, r)];
    const x = bX(p.x, p.y), gy = bY(p.x, p.y), h = TH * 1.2;
    ctx.fillStyle = '#23262c'; ctx.fillRect(x - Math.max(0.5, TW * 0.018), gy - h, Math.max(0.8, TW * 0.036), h);
    ctx.fillStyle = '#3a3f47'; ctx.fillRect(x - TW * 0.05, gy - h - TH * 0.12, TW * 0.1, TH * 0.14);
    ctx.fillStyle = 'rgba(255,224,150,0.6)'; ctx.beginPath(); ctx.arc(x, gy - h - TH * 0.02, TW * 0.05, 0, 7); ctx.fill();
  }

  const ZONE_PAL = {
    // RES = cream-walled houses with terracotta roofs; COM = glassy blue; IND = tan/grey
    [T.RES]: { top: '#ecd9b0', bot: '#cdb487', roof: '#b6452f', empty: 'rgba(120,200,120,0.18)', edge: '#5bbf6e', letter: 'R' },
    [T.COM]: { top: '#7fb4e6', bot: '#5184b4', roof: '#2c597f', empty: 'rgba(76,194,255,0.18)', edge: '#3f93d6', letter: 'C' },
    [T.IND]: { top: '#cdb46a', bot: '#a08c4e', roof: '#5f5346', empty: 'rgba(255,212,59,0.18)', edge: '#c9a13a', letter: 'I' },
  };
  // massing tables, indexed by level 1..5 (0 unused): storeys (height), footprint inset, roof style
  const STOREYS = { [T.RES]: [0, 1.0, 1.5, 2.2, 3.2, 4.2], [T.COM]: [0, 1.2, 1.9, 2.8, 3.9, 5.0], [T.IND]: [0, 1.0, 1.3, 1.7, 2.2, 2.8] };
  const INSET   = { [T.RES]: [0, 0.26, 0.22, 0.18, 0.15, 0.12], [T.COM]: [0, 0.2, 0.17, 0.14, 0.11, 0.09], [T.IND]: [0, 0.14, 0.12, 0.1, 0.09, 0.08] };
  const ROOF    = { [T.RES]: [0, 'hip', 'hip', 'hip', 'flat', 'flat'], [T.COM]: [0, 'flat', 'flat', 'flat', 'flat', 'flat'], [T.IND]: [0, 'flat', 'flat', 'flat', 'flat', 'flat'] };

  // one extruded wall face spanning ground edge g0→g1 up to elevation H, with lit/dark windows
  function wallFace(g0, g1, H, color, rows, pwr) {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(bX(g0[0], g0[1]), bY(g0[0], g0[1], 0));
    ctx.lineTo(bX(g1[0], g1[1]), bY(g1[0], g1[1], 0));
    ctx.lineTo(bX(g1[0], g1[1]), bY(g1[0], g1[1], H));
    ctx.lineTo(bX(g0[0], g0[1]), bY(g0[0], g0[1], H));
    ctx.closePath(); ctx.fill();
    if (scrTW() < 26) return;                     // LOD: skip windows when buildings are small on screen
    const cols = 2, ww = TW * 0.06, wh = TH * 0.2;
    for (let wr = 0; wr < rows; wr++) {
      for (let wc = 0; wc < cols; wc++) {
        const u = (wc + 0.5) / cols, v = (wr + 0.42) / (rows + 0.25);
        const fc = g0[0] + (g1[0] - g0[0]) * u, fr = g0[1] + (g1[1] - g0[1]) * u;
        const lit = pwr && ((wr * 3 + wc * 7 + rows) % 4 !== 0);
        ctx.fillStyle = lit ? 'rgba(255,224,150,0.95)' : (pwr ? 'rgba(190,205,220,0.5)' : 'rgba(35,48,62,0.72)');
        ctx.fillRect(bX(fc, fr) - ww / 2, bY(fc, fr, v * H) - wh / 2, ww, wh);
      }
    }
  }

  // a developed zone as an isometric box that grows taller & wider with level
  function drawBuildingIso(c, r, tile) {
    const t = tile.t, lv = tile.lvl, P = ZONE_PAL[t];
    const SH = TH * 0.82, H = STOREYS[t][lv] * SH, ins = INSET[t][lv];
    const a = c + ins, b = c + 1 - ins, p = r + ins, q = r + 1 - ins;
    const E = [b, p], S = [b, q], W = [a, q];
    const rows = clamp(Math.round(STOREYS[t][lv]), 1, 5);

    ctx.fillStyle = 'rgba(0,0,0,0.2)'; diamond(ctx, c + 0.06, r + 0.06, ins, 0); ctx.fill();  // shadow
    wallFace(W, S, H, P.bot, rows, tile.pwr);    // left wall (shaded)
    wallFace(S, E, H, P.top, rows, tile.pwr);    // right wall (lit)

    if (ROOF[t][lv] === 'hip') {                 // pitched roof → reads as a house
      const rise = SH * (t === T.RES ? 0.85 : 0.55);
      const ax = bX(c + 0.5, r + 0.5), ay = bY(c + 0.5, r + 0.5, H + rise);
      const slope = (g0, g1, col) => {
        ctx.fillStyle = col; ctx.beginPath();
        ctx.moveTo(bX(g0[0], g0[1]), bY(g0[0], g0[1], H));
        ctx.lineTo(bX(g1[0], g1[1]), bY(g1[0], g1[1], H));
        ctx.lineTo(ax, ay); ctx.closePath(); ctx.fill();
      };
      slope(W, S, shade(P.roof, -14));           // left slope
      slope(S, E, shade(P.roof, 14));            // right slope (lit)
    } else {                                     // flat roof slab
      ctx.fillStyle = shade(P.roof, 16); diamond(ctx, c, r, ins, H); ctx.fill();
      if (lv >= 4) {                             // rooftop unit on towers
        const du = 0.16, rh = H + SH * 0.5;
        ctx.fillStyle = shade(P.roof, -4);
        ctx.beginPath();
        ctx.moveTo(bX(c + 0.5 - du, r + 0.5 - du), bY(c + 0.5 - du, r + 0.5 - du, rh));
        ctx.lineTo(bX(c + 0.5 + du, r + 0.5 - du), bY(c + 0.5 + du, r + 0.5 - du, rh));
        ctx.lineTo(bX(c + 0.5 + du, r + 0.5 + du), bY(c + 0.5 + du, r + 0.5 + du, rh));
        ctx.lineTo(bX(c + 0.5 - du, r + 0.5 + du), bY(c + 0.5 - du, r + 0.5 + du, rh));
        ctx.closePath(); ctx.fill();
      }
    }
    if (t === T.IND && lv >= 2) {                // factory chimney
      const fx = c + 0.72, fy = r + 0.72, ch = SH * 1.3;
      ctx.fillStyle = '#6b5550';
      ctx.fillRect(bX(fx, fy) - TW * 0.025, bY(fx, fy, H + ch), TW * 0.05, ch);
    }
    if (!tile.pwr) noPowerIso(c, r, H + SH);
  }

  function drawServiceIso(c, r, tile, body, glyphCh, hideBadge) {
    const SH = TH * 0.82, H = SH * 1.7, ins = 0.14;
    const a = c + ins, b = c + 1 - ins, p = r + ins, q = r + 1 - ins;
    const S = [b, q], E = [b, p], W = [a, q];
    ctx.fillStyle = 'rgba(0,0,0,0.2)'; diamond(ctx, c + 0.06, r + 0.06, ins, 0); ctx.fill();
    wallFace(W, S, H, shade(body, -16), 2, false);
    wallFace(S, E, H, shade(body, 12), 2, false);
    ctx.fillStyle = shade(body, 30); diamond(ctx, c, r, ins, H); ctx.fill();
    ctx.font = (TW * 0.46) + 'px -apple-system, "Segoe UI Emoji", sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(glyphCh, bX(c + 0.5, r + 0.5), bY(c + 0.5, r + 0.5, H + TH * 0.5));
    if (!hideBadge && !tile.pwr) noPowerIso(c, r, H);
  }

  // small red ⚡ badge floating above an unpowered building
  function noPowerIso(c, r, H) {
    const x = bX(c + 0.5, r + 0.5), y = bY(c + 0.5, r + 0.5, H + TH * 0.5), rad = TW * 0.13;
    ctx.fillStyle = 'rgba(120,20,20,0.92)';
    ctx.beginPath(); ctx.arc(x, y, rad, 0, 7); ctx.fill();
    ctx.fillStyle = '#ffd6d6'; ctx.font = (rad * 1.6) + 'px sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('⚡', x, y + rad * 0.05);
  }

  // live hover cursor — an isometric diamond on the hovered tile
  function drawHover() {
    if (hoverIdx < 0) return;
    const c = hoverIdx % GRID, r = (hoverIdx / GRID) | 0;
    const bad = tool.id === 'bull';
    const a = tileToScreen(c, r, 0), b = tileToScreen(c + 1, r, 0),
          d = tileToScreen(c + 1, r + 1, 0), e = tileToScreen(c, r + 1, 0);
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.lineTo(d.x, d.y); ctx.lineTo(e.x, e.y); ctx.closePath();
    ctx.fillStyle = bad ? 'rgba(255,90,90,0.2)' : 'rgba(120,200,255,0.18)';
    ctx.fill();
    ctx.strokeStyle = bad ? 'rgba(255,120,120,0.95)' : 'rgba(160,220,255,0.95)';
    ctx.lineWidth = Math.max(1, scrTW() * 0.05);
    ctx.stroke();
    ctx.restore();
  }

  /* ---------- Street life (animated citizens) ----------
     A live layer of little wandering agents — pedestrians, dogs and the odd
     car — drawn on top of the city buffer each frame. They navigate the road
     network; dogs occasionally trot to a lamppost (or the kerb) and pee, leaving
     a puddle that slowly fades. Positions are stored in tile units so they stay
     correct at any zoom/resolution. Toggle with the "Street life" checkbox. */
  let lifeOn = true;
  const peds = [], dogs = [], cars = [];
  let marks = [];                 // fading puddles: {x,y,age,ttl} in tile units
  let roadList = [];              // road tile indices (for spawning)
  let poles = [];                 // lampposts: {c,r,x,y} in tile units
  let poleByTile = {};            // tileIndex -> pole

  const SHIRTS = ['#e6584d','#4d8fe6','#e0b13c','#57b85b','#b06fd6','#e08a3c','#46c2c2','#d8d8d8'];
  const SKINS  = ['#f1c39a','#e0a878','#c98a5a','#8d5a3a'];
  const FURS   = [['#9c6b3f','#6f4a2a'],['#d9d2c6','#a89d8a'],['#3a3a3e','#222226'],['#caa66a','#9a7842']];
  const CARCOL = ['#d24b4b','#3f7bd6','#e2c044','#4aa96c','#dadada','#5a5f6b'];

  const isRoadTile = (c, r) => inB(c, r) && map[idx(c, r)].t === T.ROAD;
  const rnd = (n) => (Math.random() * n) | 0;

  // Rebuilt whenever the city buffer is redrawn: road list, lampposts, agent counts.
  function rebuildNetwork() {
    roadList = []; poles = []; poleByTile = {};
    for (let r = 0; r < GRID; r++) {
      for (let c = 0; c < GRID; c++) {
        if (map[idx(c, r)].t !== T.ROAD) continue;
        const i = idx(c, r);
        roadList.push(i);
        // a lamppost every so often, tucked against an open kerb side
        if (((c * 7 + r * 5) % 9) === 0) {
          const oN = !isRoadTile(c, r - 1), oS = !isRoadTile(c, r + 1),
                oW = !isRoadTile(c - 1, r), oE = !isRoadTile(c + 1, r);
          if (oN || oS || oW || oE) {
            let x = c + 0.5, y = r + 0.5;
            if (oW) x = c + 0.16; else if (oE) x = c + 0.84;
            if (oN) y = r + 0.16; else if (oS) y = r + 0.84;
            const pole = { c, r, x, y };
            poles.push(pole); poleByTile[i] = pole;
          }
        }
      }
    }
    syncAgents();
  }

  function syncAgents() {
    if (!lifeOn) { peds.length = dogs.length = cars.length = 0; return; }
    const pop = stats.pop || 0, roads = roadList.length;
    fit(peds, roads ? clamp(Math.round(pop / 25),  0, 48) : 0, spawnPed);
    fit(dogs, roads ? clamp(Math.round(pop / 110), 0, 8)  : 0, spawnDog);
    fit(cars, roads ? clamp(Math.round(pop / 150), 0, 10) : 0, spawnCar);
  }
  function fit(arr, target, spawn) {
    while (arr.length > target) arr.pop();
    let guard = 0;
    while (arr.length < target && guard++ < 80) { const a = spawn(); if (a) arr.push(a); else break; }
  }

  function newAgent(extra) {
    if (!roadList.length) return null;
    const i = roadList[rnd(roadList.length)];
    const c = i % GRID, r = (i / GRID) | 0;
    const a = Object.assign({
      c, r, pc: c, pr: r, nc: c, nr: r, t: Math.random(),
      lane: (Math.random() < 0.5 ? -1 : 1) * 0.22,
      phase: Math.random() * 6.28, state: 'walk', timer: 0,
    }, extra);
    pickNext(a);
    return a;
  }
  const spawnPed = () => newAgent({ kind: 'ped', speed: 0.9 + Math.random() * 0.7,
    color: SHIRTS[rnd(SHIRTS.length)], skin: SKINS[rnd(SKINS.length)] });
  const spawnDog = () => { const f = FURS[rnd(FURS.length)];
    return newAgent({ kind: 'dog', speed: 1.2 + Math.random() * 0.8,
      lane: (Math.random() < 0.5 ? -1 : 1) * 0.24, fur: f[0], fur2: f[1], peeCd: 3 + rnd(6) }); };
  const spawnCar = () => newAgent({ kind: 'car', speed: 2.3 + Math.random() * 1.3, lane: 0.2,
    color: CARCOL[rnd(CARCOL.length)] });

  // choose the next road tile to walk to (avoid an immediate U-turn unless forced)
  function pickNext(a) {
    const nb = [];
    if (isRoadTile(a.c, a.r - 1)) nb.push([a.c, a.r - 1]);
    if (isRoadTile(a.c, a.r + 1)) nb.push([a.c, a.r + 1]);
    if (isRoadTile(a.c - 1, a.r)) nb.push([a.c - 1, a.r]);
    if (isRoadTile(a.c + 1, a.r)) nb.push([a.c + 1, a.r]);
    if (!nb.length) { a.nc = a.c; a.nr = a.r; return; }
    let opts = nb.filter(([c, r]) => !(c === a.pc && r === a.pr));
    if (!opts.length) opts = nb;
    const [nc, nr] = opts[rnd(opts.length)];
    a.nc = nc; a.nr = nr;
  }

  function startPee(a) {
    a.state = 'pee'; a.timer = 1.2 + Math.random() * 0.6;
    const pole = poleByTile[idx(a.c, a.r)];
    let ox, oy;
    if (pole) { ox = pole.x - (a.c + 0.5); oy = pole.y - (a.r + 0.5); }
    else {
      const sides = [];
      if (!isRoadTile(a.c, a.r - 1)) sides.push([0, -1]);
      if (!isRoadTile(a.c, a.r + 1)) sides.push([0, 1]);
      if (!isRoadTile(a.c - 1, a.r)) sides.push([-1, 0]);
      if (!isRoadTile(a.c + 1, a.r)) sides.push([1, 0]);
      const s = sides.length ? sides[rnd(sides.length)] : [0, 1];
      ox = s[0] * 0.32; oy = s[1] * 0.32;
    }
    a.peeOx = ox; a.peeOy = oy;
    marks.push({ x: a.c + 0.5 + ox, y: a.r + 0.5 + oy * 0.9, age: 0, ttl: 8 });
  }

  function stepAgent(a, dt) {
    if (!isRoadTile(a.c, a.r)) {                 // road bulldozed under it → respawn
      if (!roadList.length) return;
      const i = roadList[rnd(roadList.length)];
      a.c = i % GRID; a.r = (i / GRID) | 0; a.pc = a.c; a.pr = a.r; a.t = 0; a.state = 'walk';
      pickNext(a); return;
    }
    if (a.state !== 'walk') {                     // pausing or peeing → stand still
      a.timer -= dt;
      if (a.timer <= 0) { a.state = 'walk'; if (a.kind === 'dog') a.peeCd = 4 + rnd(7); pickNext(a); }
      return;
    }
    a.t += a.speed * dt;
    a.phase += a.speed * dt * 9;
    while (a.t >= 1) {
      a.t -= 1;
      a.pc = a.c; a.pr = a.r; a.c = a.nc; a.r = a.nr;
      if (a.kind === 'dog' && (a.peeCd -= 1) <= 0 && Math.random() < 0.55) { startPee(a); return; }
      if (a.kind === 'ped' && Math.random() < 0.05) { a.state = 'pause'; a.timer = 0.4 + Math.random() * 1.3; return; }
      pickNext(a);
    }
  }

  function updateAgents(dtMs) {
    if (!lifeOn) return;
    const dt = Math.min(0.05, dtMs / 1000);       // clamp so a stalled tab doesn't teleport everyone
    for (const a of peds) stepAgent(a, dt);
    for (const a of dogs) stepAgent(a, dt);
    for (const a of cars) stepAgent(a, dt);
    for (let k = marks.length - 1; k >= 0; k--) {
      marks[k].age += dt; if (marks[k].age >= marks[k].ttl) marks.splice(k, 1);
    }
  }

  // continuous tile position of an agent (incl. perpendicular lane offset) + heading
  function agentTile(a) {
    const dx = a.nc - a.c, dy = a.nr - a.r;
    const fc = a.c + 0.5 + dx * a.t - dy * a.lane;
    const fr = a.r + 0.5 + dy * a.t + dx * a.lane;
    return { fc, fr, dx, dy };
  }

  // Draw all 3D objects (buildings/services/trees/lampposts) and live agents in a
  // single back-to-front pass so buildings occlude the people & dogs behind them.
  // Static objects draw in buffer space (via a canvas transform); agents draw in
  // screen space — we flip the transform as the sorted list demands.
  function drawTallLayer() {
    const items = [];
    for (let r = 0; r < GRID; r++) {
      for (let c = 0; c < GRID; c++) {
        const i = idx(c, r), tile = map[i], t = tile.t, d = c + r + 1;   // tile-centre depth (matches agents)
        if (t === T.TREE)        items.push({ k: 'tree', c, r, d });
        else if (t === T.POWER)  items.push({ k: 'svc', c, r, tile, body: '#7a6a34', gl: '⚡', hb: true,  d });
        else if (t === T.POLICE) items.push({ k: 'svc', c, r, tile, body: '#2f5296', gl: '🚓', hb: false, d });
        else if (t === T.FIRE)   items.push({ k: 'svc', c, r, tile, body: '#9c3030', gl: '🚒', hb: false, d });
        else if (isZone(t) && tile.lvl > 0) items.push({ k: 'bld', c, r, tile, d });
        if (poleByTile[i]) items.push({ k: 'pole', c, r, d: d + 0.02 });
      }
    }
    if (lifeOn) {
      for (const m of marks) items.push({ k: 'mark', m, d: m.x + m.y });
      for (const a of cars) { const p = agentTile(a); items.push({ k: 'car', a, p, d: p.fc + p.fr - 0.05 }); }
      for (const a of dogs) { const p = agentTile(a); items.push({ k: 'dog', a, p, d: p.fc + p.fr }); }
      for (const a of peds) { const p = agentTile(a); items.push({ k: 'ped', a, p, d: p.fc + p.fr }); }
    }
    items.sort((u, v) => u.d - v.d);

    const S = scrScale(), m = scrTW() * 3.5 + 40;   // cull margin big enough for the tallest tower
    ctx.save();
    let mode = 0;
    const buf = () => { if (mode !== 1) { ctx.setTransform(S * DPR, 0, 0, S * DPR, cam.x * DPR, cam.y * DPR); mode = 1; } };
    const scr = () => { if (mode !== 2) { ctx.setTransform(DPR, 0, 0, DPR, 0, 0); mode = 2; } };
    for (const it of items) {
      if (it.k === 'bld' || it.k === 'svc' || it.k === 'tree' || it.k === 'pole') {
        const sp = tileToScreen(it.c + 0.5, it.r + 0.5, 0);
        if (sp.x < -m || sp.x > viewW + m || sp.y < -m || sp.y > viewH + m) continue;
        buf();
        if (it.k === 'bld') drawBuildingIso(it.c, it.r, it.tile);
        else if (it.k === 'svc') drawServiceIso(it.c, it.r, it.tile, it.body, it.gl, it.hb);
        else if (it.k === 'tree') drawTreeIso(it.c, it.r);
        else drawPoleIso(it.c, it.r);
      } else {
        scr();
        if (it.k === 'mark') drawMark(it.m);
        else if (it.k === 'car') drawCar(it.a, it.p);
        else if (it.k === 'dog') drawDog(it.a, it.p);
        else drawPed(it.a, it.p);
      }
    }
    ctx.restore();
  }

  function drawMark(m) {
    const a = 1 - m.age / m.ttl;
    if (a <= 0) return;
    const g = tileToScreen(m.x, m.y, 0), s = scrTW();
    ctx.fillStyle = 'rgba(226,206,72,' + (0.32 * a).toFixed(3) + ')';
    ctx.beginPath(); ctx.ellipse(g.x, g.y, s * 0.16, s * 0.08, 0, 0, 6.3); ctx.fill();
  }

  // screen-space heading of an agent (project a short step ahead)
  function headAngle(p) {
    const g = tileToScreen(p.fc, p.fr, 0);
    const h = tileToScreen(p.fc + (p.dx || 0.6) * 0.3, p.fr + (p.dy || 0) * 0.3, 0);
    return Math.atan2(h.y - g.y, h.x - g.x);
  }

  function drawPed(a, p) {
    const g = tileToScreen(p.fc, p.fr, 0), s = scrTW(), walking = a.state === 'walk';
    const bob = walking ? Math.abs(Math.sin(a.phase)) * s * 0.04 : 0;
    ctx.fillStyle = 'rgba(0,0,0,0.22)';
    ctx.beginPath(); ctx.ellipse(g.x, g.y, s * 0.12, s * 0.06, 0, 0, 6.3); ctx.fill();
    const foot = g.y - bob;
    const sw = walking ? Math.sin(a.phase) * s * 0.06 : 0;
    ctx.strokeStyle = '#2b2f36'; ctx.lineWidth = Math.max(1, s * 0.045);
    ctx.beginPath();
    ctx.moveTo(g.x - s * 0.03, foot - s * 0.16); ctx.lineTo(g.x - s * 0.03 + sw, foot);
    ctx.moveTo(g.x + s * 0.03, foot - s * 0.16); ctx.lineTo(g.x + s * 0.03 - sw, foot);
    ctx.stroke();
    const by = foot - s * 0.34;
    ctx.fillStyle = a.color;                                      // shirt
    roundRect(ctx, g.x - s * 0.08, by, s * 0.16, s * 0.2, s * 0.05); ctx.fill();
    ctx.fillStyle = a.skin;                                       // head
    ctx.beginPath(); ctx.arc(g.x, by - s * 0.06, s * 0.07, 0, 6.3); ctx.fill();
  }

  function drawDog(a, p) {
    const g = tileToScreen(p.fc, p.fr, 0), s = scrTW();
    let lift = 0, peeT = 0, pp = p;
    if (a.state === 'pee') { lift = 1; peeT = 1 - clamp(a.timer / 1.8, 0, 1); pp = { fc: p.fc, fr: p.fr, dx: a.peeOx, dy: a.peeOy }; }
    const ang = headAngle(pp), L = s * 0.16, H = s * 0.09;
    ctx.save(); ctx.translate(g.x, g.y); ctx.rotate(ang);
    ctx.fillStyle = 'rgba(0,0,0,0.2)'; ctx.beginPath(); ctx.ellipse(0, 0, L, H * 0.6, 0, 0, 6.3); ctx.fill();
    ctx.translate(0, -H);                                          // stand the dog up off the ground
    const sw = a.state === 'walk' ? Math.sin(a.phase) * s * 0.05 : 0;
    ctx.strokeStyle = a.fur2; ctx.lineWidth = Math.max(1, s * 0.035);
    ctx.beginPath();
    ctx.moveTo(L * 0.5, 0); ctx.lineTo(L * 0.5 + sw, H);          // front leg
    if (lift) { ctx.moveTo(-L * 0.5, 0); ctx.lineTo(-L * 0.95, -H * 0.7); }  // cocked hind leg
    else { ctx.moveTo(-L * 0.5, 0); ctx.lineTo(-L * 0.5 - sw, H); }
    ctx.stroke();
    ctx.fillStyle = a.fur;
    ctx.beginPath(); ctx.ellipse(0, 0, L, H, 0, 0, 6.3); ctx.fill();           // body
    ctx.beginPath(); ctx.arc(L * 0.85, -H * 0.4, H, 0, 6.3); ctx.fill();        // head
    const wag = Math.sin(a.phase * 1.6) * 0.5;
    ctx.strokeStyle = a.fur; ctx.lineWidth = Math.max(1, s * 0.05);
    ctx.beginPath(); ctx.moveTo(-L * 0.9, -H * 0.2); ctx.lineTo(-L * 1.5, -H * 0.7 + wag * H); ctx.stroke(); // tail
    if (lift && peeT > 0.2) {                                      // the deed
      ctx.strokeStyle = 'rgba(240,222,84,0.85)'; ctx.lineWidth = Math.max(1, s * 0.03);
      ctx.beginPath(); ctx.moveTo(-L * 0.7, H * 0.1); ctx.lineTo(-L * 1.05 - H * 0.5, H * 1.1); ctx.stroke();
    }
    ctx.restore();
  }

  function drawCar(a, p) {
    const g = tileToScreen(p.fc, p.fr, 0), s = scrTW(), ang = headAngle(p);
    const L = s * 0.34, W = s * 0.2;
    ctx.save(); ctx.translate(g.x, g.y - s * 0.07); ctx.rotate(ang);
    ctx.fillStyle = 'rgba(0,0,0,0.22)'; roundRect(ctx, -L / 2 + s * 0.02, -W / 2 + s * 0.04, L, W, s * 0.05); ctx.fill();
    ctx.fillStyle = a.color; roundRect(ctx, -L / 2, -W / 2, L, W, s * 0.05); ctx.fill();
    ctx.fillStyle = 'rgba(220,240,255,0.45)'; roundRect(ctx, -L * 0.05, -W * 0.34, L * 0.34, W * 0.68, s * 0.03); ctx.fill();
    ctx.fillStyle = 'rgba(255,240,180,0.95)';                     // headlights (front)
    ctx.fillRect(L * 0.42, -W * 0.34, s * 0.035, W * 0.22);
    ctx.fillRect(L * 0.42, W * 0.12, s * 0.035, W * 0.22);
    ctx.restore();
  }

  /* ---------- UI sync ---------- */
  function updateUI() {
    document.getElementById('stat-money').textContent = fmtMoney(money);
    document.getElementById('stat-pop').textContent = stats.pop.toLocaleString('en-US');
    document.getElementById('stat-date').textContent =
      MONTHS[month % 12] + ' ' + (1900 + Math.floor(month / 12));
    document.getElementById('stat-approval').textContent = approval + '%';

    const netEl = document.getElementById('stat-net');
    netEl.textContent = (lastNet >= 0 ? '+' : '') + fmtMoney(lastNet) + '/mo';
    netEl.className = 'sub ' + (lastNet >= 0 ? 'pos' : 'neg');

    setRci('rci-r', demand.r);
    setRci('rci-c', demand.c);
    setRci('rci-i', demand.i);
  }

  // RCI bar: fills upward (green) for positive demand, downward for negative
  function setRci(id, value) {
    const el = document.getElementById(id);
    const norm = clamp(value / 260, -1, 1);
    const half = 20; // px, half of 40px bar
    if (norm >= 0) {
      el.style.bottom = '50%';
      el.style.top = 'auto';
      el.style.height = (norm * half) + 'px';
      el.style.opacity = '1';
    } else {
      el.style.top = '50%';
      el.style.bottom = 'auto';
      el.style.height = (-norm * half) + 'px';
      el.style.opacity = '0.55';
    }
  }

  function setHint(msg) { hintEl.textContent = msg; }

  /* ---------- Input ---------- */
  let painting = false, lastPaint = -1;

  /* ---------- Undo (Cmd/Ctrl+Z), batched per drag-stroke ---------- */
  let undoStack = [], curBatch = null;
  function beginBatch() { curBatch = { tiles: [], seen: new Set(), delta: 0 }; }
  function snapshot(i) {                               // record a tile's state before it changes
    if (!curBatch || curBatch.seen.has(i)) return;
    curBatch.seen.add(i);
    const t = map[i];
    curBatch.tiles.push({ i, t: t.t, lvl: t.lvl, pwr: t.pwr });
  }
  function spend(dm) { money += dm; if (curBatch) curBatch.delta += dm; }   // money change, tracked for undo
  function endBatch() {
    if (curBatch && curBatch.tiles.length) { undoStack.push(curBatch); if (undoStack.length > 80) undoStack.shift(); }
    curBatch = null;
  }
  function undo() {
    const b = undoStack.pop();
    if (!b) { setHint('Nothing to undo.'); return; }
    for (const s of b.tiles) { const t = map[s.i]; t.t = s.t; t.lvl = s.lvl; t.pwr = s.pwr; }
    money -= b.delta;                                  // reverse the stroke's money change
    fullStatsPass(); updateUI(); markDirty();
    setHint('↩︎ Undone (' + b.tiles.length + ' tile' + (b.tiles.length > 1 ? 's' : '') + ').');
  }

  function tileFromEvent(e) {
    const rect = canvas.getBoundingClientRect();
    const p = screenToTile(e.clientX - rect.left, e.clientY - rect.top);
    const c = Math.floor(p.fc), r = Math.floor(p.fr);
    return inB(c, r) ? idx(c, r) : -1;
  }

  function place(i) {
    if (i < 0 || i === lastPaint) return;
    lastPaint = i;
    const tile = map[i];

    if (tool.id === 'bull') {
      if (tile.t === T.GRASS) return;
      if (tile.t === T.WATER) { setHint("Can't bulldoze water."); return; }
      snapshot(i);                                     // always allowed — even when you're broke
      const refund = Math.round((BUILD_COST[tile.t] || 0) * 0.5);
      if (refund) { spend(refund); setHint('⛏️ Demolished · +' + fmtMoney(refund) + ' refund.'); }
      tile.t = T.GRASS; tile.lvl = 0; tile.pwr = false;
      afterEdit();
      return;
    }

    // can't build on water (except nothing); building over existing pays again only if different
    if (tile.t === T.WATER) { setHint("That's water — bridges aren't in this version."); return; }
    if (tile.t === tool.type && !isZone(tool.type)) return; // already that
    if (tile.t === tool.type && isZone(tool.type)) return;  // already zoned same

    if (money < tool.cost) { brokeHint(); return; }
    snapshot(i); spend(-tool.cost);
    tile.t = tool.type;
    tile.lvl = 0;
    afterEdit();
  }

  function brokeHint() { setHint('💸 Not enough funds for that. Raise taxes or grow your tax base.'); }

  function afterEdit() {
    fullStatsPass();
    updateUI();
    markDirty();
  }

  let panning = false, panSX = 0, panSY = 0, panCX = 0, panCY = 0;

  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  canvas.addEventListener('mousedown', (e) => {
    if (e.button === 2 || e.button === 1) {          // right / middle drag → pan
      panning = true; panSX = e.clientX; panSY = e.clientY; panCX = cam.x; panCY = cam.y;
      canvas.style.cursor = 'grabbing'; e.preventDefault(); return;
    }
    painting = true; lastPaint = -1;
    beginBatch();
    place(tileFromEvent(e));
  });
  window.addEventListener('mouseup', () => {
    if (painting) endBatch();
    painting = false; lastPaint = -1;
    if (panning) { panning = false; canvas.style.cursor = 'crosshair'; }
  });
  canvas.addEventListener('mousemove', (e) => {
    if (panning) {
      cam.x = panCX + (e.clientX - panSX);
      cam.y = panCY + (e.clientY - panSY);
      clampCam(); tooltip.style.display = 'none'; return;
    }
    const i = tileFromEvent(e);
    hoverIdx = i;
    if (painting) place(i);
    showTooltip(e, i);
  });
  canvas.addEventListener('mouseleave', () => {
    tooltip.style.display = 'none';
    hoverIdx = -1;
  });
  // wheel / pinch → zoom toward the cursor
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const sx = e.clientX - rect.left, sy = e.clientY - rect.top;
    const S0 = scrScale();
    const bx = (sx - cam.x) / S0, by = (sy - cam.y) / S0;     // buffer point under cursor
    cam.zoom = clamp(cam.zoom * Math.exp(-e.deltaY * 0.0015), 1, Z_MAX);
    const S1 = scrScale();
    cam.x = sx - bx * S1; cam.y = sy - by * S1;               // keep that point under the cursor
    clampCam();
  }, { passive: false });

  function showTooltip(e, i) {
    if (i < 0) { tooltip.style.display = 'none'; return; }
    const tile = map[i];
    const names = {
      [T.GRASS]: 'Grass', [T.ROAD]: 'Road', [T.RES]: 'Residential',
      [T.COM]: 'Commercial', [T.IND]: 'Industrial', [T.POWER]: 'Power Plant',
      [T.PARK]: 'Park', [T.POLICE]: 'Police', [T.FIRE]: 'Fire Station',
      [T.WATER]: 'River', [T.TREE]: 'Trees',
    };
    let txt = names[tile.t];
    if (isZone(tile.t)) {
      txt += tile.lvl === 0 ? ' · undeveloped' : ' · level ' + tile.lvl;
      if (!tile.pwr) txt += ' · ⚡ no power';
      else if (!hasRoadNear(i)) txt += ' · 🚧 no road nearby';
    }
    tooltip.textContent = txt;
    // fixed pill at the top of the map — never covers the tile you're pointing at
    tooltip.style.left = '50%';
    tooltip.style.top = '10px';
    tooltip.style.bottom = 'auto';
    tooltip.style.transform = 'translateX(-50%)';
    tooltip.style.display = 'block';
  }

  /* ---------- Tool palette UI ---------- */
  function buildPalette() {
    const list = document.getElementById('tool-list');
    list.innerHTML = '';
    TOOLS.forEach((tl) => {
      const b = document.createElement('button');
      b.className = 'tool' + (tl.id === tool.id ? ' active' : '');
      b.dataset.id = tl.id;
      b.innerHTML =
        `<span class="ico">${tl.ico}</span>
         <span class="meta"><span class="name">${tl.name}</span>
         <span class="cost">$${tl.cost.toLocaleString('en-US')} · key ${tl.key}</span></span>`;
      b.addEventListener('click', () => selectTool(tl.id));
      list.appendChild(b);
    });
  }

  function selectTool(id) {
    tool = TOOLS.find((t) => t.id === id) || TOOLS[0];
    document.querySelectorAll('.tool').forEach((el) =>
      el.classList.toggle('active', el.dataset.id === id));
    setHint(toolHint(tool));
  }

  function toolHint(tl) {
    switch (tl.id) {
      case 'road': return 'Drag to lay roads. Zones need a road within 3 tiles.';
      case 'res': return 'Zone homes. They fill up when there are jobs (positive R demand).';
      case 'com': return 'Zone shops. Demand rises with population.';
      case 'ind': return 'Zone industry. Provides jobs; demand rises with population.';
      case 'power': return 'Drop a plant. Power flows through roads & buildings (~130 tiles each).';
      case 'park': return 'Parks raise land value nearby — buildings grow taller.';
      case 'police': return 'Cuts crime, protects land value in dense areas.';
      case 'fire': return 'Fire coverage keeps land value healthy.';
      case 'bull': return 'Drag to demolish. (Rivers are permanent.)';
      default: return '';
    }
  }

  /* ---------- Speed / controls ---------- */
  function setSpeed(s) {
    speed = s;
    document.querySelectorAll('.speed button').forEach((b) =>
      b.classList.toggle('active', +b.dataset.speed === s));
  }

  document.querySelectorAll('.speed button').forEach((b) =>
    b.addEventListener('click', () => setSpeed(+b.dataset.speed)));

  document.getElementById('tax-slider').addEventListener('input', (e) => {
    tax = +e.target.value;
    document.getElementById('tax-val').textContent = tax;
  });

  document.getElementById('btn-save').addEventListener('click', save);
  document.getElementById('btn-load').addEventListener('click', () => load(true));
  document.getElementById('btn-new').addEventListener('click', () => {
    if (confirm('Start a brand new city? Your current one will be cleared (use Save first).'))
      newCity();
  });

  const helpOverlay = document.getElementById('help-overlay');
  document.getElementById('btn-help').addEventListener('click', () => helpOverlay.classList.remove('hidden'));
  document.getElementById('btn-help-close').addEventListener('click', () => helpOverlay.classList.add('hidden'));

  const lifeToggle = document.getElementById('toggle-life');
  if (lifeToggle) lifeToggle.addEventListener('change', (e) => {
    lifeOn = e.target.checked;
    marks.length = 0;
    markDirty();          // forces a buffer redraw → rebuildNetwork → (re)populate or clear agents
  });
  helpOverlay.addEventListener('click', (e) => { if (e.target === helpOverlay) helpOverlay.classList.add('hidden'); });

  window.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT') return;
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); undo(); return; }
    if (e.key === ' ') { e.preventDefault(); setSpeed(speed === 0 ? 1 : 0); return; }
    if (e.key === '0') { resetView(); return; }
    if (e.key === '+' || e.key === '=') { zoomBy(1.2); return; }
    if (e.key === '-' || e.key === '_') { zoomBy(1 / 1.2); return; }
    const pan = 70;
    if (e.key === 'ArrowLeft')  { cam.x += pan; clampCam(); e.preventDefault(); return; }
    if (e.key === 'ArrowRight') { cam.x -= pan; clampCam(); e.preventDefault(); return; }
    if (e.key === 'ArrowUp')    { cam.y += pan; clampCam(); e.preventDefault(); return; }
    if (e.key === 'ArrowDown')  { cam.y -= pan; clampCam(); e.preventDefault(); return; }
    if (e.key.toLowerCase() === 'b') { selectTool('bull'); return; }
    const tl = TOOLS.find((t) => t.key === e.key);
    if (tl) selectTool(tl.id);
  });

  /* ---------- Save / Load ---------- */
  function save() {
    try {
      const types = new Array(N), levels = new Array(N);
      for (let i = 0; i < N; i++) { types[i] = map[i].t; levels[i] = map[i].lvl; }
      const data = { v: 1, types, levels, money, tax, month, GRID };
      localStorage.setItem(SAVE_KEY, JSON.stringify(data));
      setHint('💾 City saved to this browser (' + MONTHS[month % 12] + ' ' + (1900 + (month/12|0)) + ').');
    } catch (err) {
      setHint('⚠️ Save failed (browser storage blocked). Try a normal browser tab.');
    }
  }

  function load(announce) {
    try {
      const raw = localStorage.getItem(SAVE_KEY);
      if (!raw) { if (announce) setHint('No saved city found yet — build one and hit Save.'); return false; }
      const data = JSON.parse(raw);
      if (data.GRID !== GRID) { setHint('Saved city is incompatible with this version.'); return false; }
      map = new Array(N);
      for (let i = 0; i < N; i++) {
        map[i] = { t: data.types[i], lvl: data.levels[i] || 0, pwr: false };
      }
      money = data.money; tax = data.tax; month = data.month;
      undoStack.length = 0; curBatch = null;
      document.getElementById('tax-slider').value = tax;
      document.getElementById('tax-val').textContent = tax;
      fullStatsPass();
      computeStats(); computeDemand();
      updateUI();
      markDirty();
      if (announce) setHint('📂 City loaded.');
      return true;
    } catch (err) {
      setHint('⚠️ Could not load saved city.');
      return false;
    }
  }

  /* ---------- Main loop ---------- */
  let acc = 0, lastTs = performance.now();
  function loop(ts) {
    const dt = ts - lastTs; lastTs = ts;
    const interval = SPEED_MS[speed];
    if (interval !== Infinity) {
      acc += dt;
      while (acc >= interval) { acc -= interval; tick(); }
    } else {
      acc = 0;
    }
    updateAgents(dt);
    render();
    requestAnimationFrame(loop);
  }

  /* ---------- Boot ---------- */
  buildPalette();
  fitCanvas();
  window.addEventListener('resize', fitCanvas);
  if (!load(false)) {
    newCity();
    helpOverlay.classList.remove('hidden'); // show help on first ever run
  } else {
    setSpeed(1);
    setHint('Welcome back, Mayor. Your saved city is loaded.');
  }
  // autosave every ~2 game-years
  setInterval(() => { if (month > 0) save(); }, 60000);
  requestAnimationFrame(loop);
}
