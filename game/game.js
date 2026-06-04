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
    { id: 'bull',   type: T.GRASS,  name: 'Bulldoze',     ico: '⛏️', cost: 2,    key: '9' },
  ];

  // Per-tile monthly upkeep
  const UPKEEP = { [T.ROAD]: 1, [T.POWER]: 90, [T.POLICE]: 90, [T.FIRE]: 90, [T.PARK]: 2 };

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

  /* ---------- Camera (zoom & pan) ---------- */
  const cam = { zoom: 1, x: 0, y: 0 };        // zoom factor; x,y = screen px of world tile (0,0)
  let baseFit = 18, viewW = 820, viewH = 820, DPR = 1, Z_MAX = 3;
  const scrTile = () => baseFit * cam.zoom;    // on-screen px per tile

  function clampCam() {
    cam.zoom = clamp(cam.zoom, 1, Z_MAX);
    const t = scrTile(), mapW = GRID * t, mapH = GRID * t;
    cam.x = mapW <= viewW ? (viewW - mapW) / 2 : clamp(cam.x, viewW - mapW, 0);
    cam.y = mapH <= viewH ? (viewH - mapH) / 2 : clamp(cam.y, viewH - mapH, 0);
  }
  function resetView() { cam.zoom = 1; clampCam(); }
  function zoomBy(f) {                          // zoom toward the view centre
    const cx = viewW / 2, cy = viewH / 2, t0 = scrTile();
    const wx = (cx - cam.x) / t0, wy = (cy - cam.y) / t0;
    cam.zoom = clamp(cam.zoom * f, 1, Z_MAX);
    const t1 = scrTile();
    cam.x = cx - wx * t1; cam.y = cy - wy * t1; clampCam();
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

    baseFit = Math.max(8, Math.floor(Math.min(viewW, viewH) / GRID)); // zoom=1 fits the map
    Z_MAX = 3;

    // visible canvas fills the viewport
    canvas.style.width  = viewW + 'px';
    canvas.style.height = viewH + 'px';
    canvas.width  = Math.round(viewW * DPR);
    canvas.height = Math.round(viewH * DPR);
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);

    // offscreen buffer holds the whole map at a supersampled tile size (capped for memory)
    TILE = Math.min(baseFit * 2, Math.floor(4096 / DPR / GRID));
    scene.width  = Math.round(GRID * TILE * DPR);
    scene.height = Math.round(GRID * TILE * DPR);
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

  // Per-frame: blit the buffer (re-rendering it first if the map changed),
  // then draw the live hover cursor on top.
  function render() {
    if (dirty) { renderScene(); dirty = false; }
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    // blit the whole-map buffer into the current camera view
    const t = scrTile();
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(scene, 0, 0, scene.width, scene.height,
                  cam.x * DPR, cam.y * DPR, GRID * t * DPR, GRID * t * DPR);
    ctx.restore();
    drawAgents();
    drawHover();
  }

  // Full redraw of the city into the offscreen buffer.
  function renderScene() {
    const W = GRID * TILE, H = GRID * TILE;
    sctx.clearRect(0, 0, W, H);

    // grass gradient base (smooth, no per-tile colour blocks)
    const bg = sctx.createLinearGradient(0, 0, 0, H);
    bg.addColorStop(0, '#43592b');
    bg.addColorStop(1, '#2c3c1b');
    sctx.fillStyle = bg;
    sctx.fillRect(0, 0, W, H);

    for (let r = 0; r < GRID; r++)
      for (let c = 0; c < GRID; c++)
        drawTile(c, r, map[idx(c, r)]);

    // refresh the agent road-network and paint lampposts into the buffer
    rebuildNetwork();
    for (const pole of poles) drawPole(pole);

    // soft vignette for depth
    const vg = sctx.createRadialGradient(
      W / 2, H / 2, Math.min(W, H) * 0.32,
      W / 2, H / 2, Math.max(W, H) * 0.62);
    vg.addColorStop(0, 'rgba(0,0,0,0)');
    vg.addColorStop(1, 'rgba(0,0,0,0.22)');
    sctx.fillStyle = vg;
    sctx.fillRect(0, 0, W, H);
  }

  function drawTile(c, r, tile) {
    const x = c * TILE, y = r * TILE, t = tile.t;
    // water & road fill the whole tile; everything else sits on grass
    if (t === T.WATER) { drawWater(c, r, x, y); return; }
    if (t === T.ROAD)  { drawRoad(c, r, x, y); return; }
    drawGrass(c, r, x, y);
    switch (t) {
      case T.TREE:   drawTree(x, y); return;
      case T.PARK:   drawPark(x, y); return;
      case T.POWER:  drawService(x, y, tile, '#6b5a2a', '⚡', true);  return;
      case T.POLICE: drawService(x, y, tile, '#2b4a8a', '🚓', false); return;
      case T.FIRE:   drawService(x, y, tile, '#8a2b2b', '🚒', false); return;
      case T.RES: case T.COM: case T.IND: drawZone(x, y, tile); return;
    }
  }

  // tiny deterministic flecks → organic grass texture with no block edges
  function drawGrass(c, r, x, y) {
    const s = Math.max(1, TILE * 0.07);
    for (let k = 0; k < 2; k++) {
      const hx = ((c * 7 + r * 13 + k * 29) % 17) / 17;
      const hy = ((c * 11 + r * 5 + k * 19) % 13) / 13;
      sctx.fillStyle = (k % 2) ? 'rgba(150,180,90,0.20)' : 'rgba(40,60,25,0.20)';
      sctx.fillRect(x + hx * TILE, y + hy * TILE, s, s);
    }
  }

  function drawWater(c, r, x, y) {
    const grd = sctx.createLinearGradient(x, y, x, y + TILE);
    grd.addColorStop(0, '#2a6390');
    grd.addColorStop(1, '#173f5f');
    sctx.fillStyle = grd;
    sctx.fillRect(x, y, TILE, TILE);
    // ripple highlights
    sctx.fillStyle = 'rgba(255,255,255,0.07)';
    const off = ((c * 3 + r * 5) % 5) / 5 * TILE;
    sctx.fillRect(x + TILE * 0.14, y + off * 0.4 + TILE * 0.2, TILE * 0.5, Math.max(1, TILE * 0.05));
    sctx.fillRect(x + TILE * 0.42, y + off * 0.4 + TILE * 0.5, TILE * 0.32, Math.max(1, TILE * 0.04));
    // sandy shoreline against any adjacent land
    const land = (cc, rr) => !inB(cc, rr) || map[idx(cc, rr)].t !== T.WATER;
    const w = Math.max(1, TILE * 0.12);
    sctx.fillStyle = 'rgba(190,205,150,0.20)';
    if (land(c, r - 1)) sctx.fillRect(x, y, TILE, w);
    if (land(c, r + 1)) sctx.fillRect(x, y + TILE - w, TILE, w);
    if (land(c - 1, r)) sctx.fillRect(x, y, w, TILE);
    if (land(c + 1, r)) sctx.fillRect(x + TILE - w, y, w, TILE);
  }

  function drawTree(x, y) {
    const cx = x + TILE / 2, cy = y + TILE * 0.5, R = TILE * 0.33;
    sctx.fillStyle = 'rgba(0,0,0,0.22)';
    sctx.beginPath();
    sctx.ellipse(cx + TILE * 0.05, cy + TILE * 0.18, R * 0.95, R * 0.5, 0, 0, 7);
    sctx.fill();
    sctx.fillStyle = '#5b3d22';
    sctx.fillRect(cx - Math.max(1, TILE * 0.04), cy, Math.max(1.5, TILE * 0.08), TILE * 0.26);
    sctx.fillStyle = '#274d1c';
    sctx.beginPath(); sctx.arc(cx, cy, R, 0, 7); sctx.fill();
    sctx.fillStyle = '#356b27';
    sctx.beginPath(); sctx.arc(cx - R * 0.25, cy - R * 0.25, R * 0.72, 0, 7); sctx.fill();
    sctx.fillStyle = '#4f8f37';
    sctx.beginPath(); sctx.arc(cx - R * 0.38, cy - R * 0.42, R * 0.4, 0, 7); sctx.fill();
  }

  function drawPark(x, y) {
    const pad = TILE * 0.1;
    const grd = sctx.createLinearGradient(0, y, 0, y + TILE);
    grd.addColorStop(0, '#357a2b');
    grd.addColorStop(1, '#245420');
    sctx.fillStyle = grd;
    roundRect(sctx, x + pad, y + pad, TILE - pad * 2, TILE - pad * 2, TILE * 0.16);
    sctx.fill();
    // winding path
    sctx.strokeStyle = 'rgba(214,200,150,0.55)';
    sctx.lineWidth = Math.max(1, TILE * 0.07);
    sctx.beginPath();
    sctx.moveTo(x + TILE * 0.2, y + TILE * 0.82);
    sctx.quadraticCurveTo(x + TILE * 0.5, y + TILE * 0.5, x + TILE * 0.82, y + TILE * 0.2);
    sctx.stroke();
    // bushes
    sctx.fillStyle = '#3e8a33';
    sctx.beginPath(); sctx.arc(x + TILE * 0.3, y + TILE * 0.32, TILE * 0.13, 0, 7); sctx.fill();
    sctx.fillStyle = '#4c9b3d';
    sctx.beginPath(); sctx.arc(x + TILE * 0.7, y + TILE * 0.7, TILE * 0.12, 0, 7); sctx.fill();
  }

  function drawRoad(c, r, x, y) {
    const isR = (cc, rr) => inB(cc, rr) && map[idx(cc, rr)].t === T.ROAD;
    const up = isR(c, r - 1), dn = isR(c, r + 1), lt = isR(c - 1, r), rt = isR(c + 1, r);
    const links = up + dn + lt + rt;
    // asphalt
    const grd = sctx.createLinearGradient(x, y, x, y + TILE);
    grd.addColorStop(0, '#454951');
    grd.addColorStop(1, '#34383e');
    sctx.fillStyle = grd;
    sctx.fillRect(x, y, TILE, TILE);
    // curbs on the open sides (where the road doesn't continue)
    const cw = Math.max(1, TILE * 0.1);
    sctx.fillStyle = '#5b616b';
    if (!up) sctx.fillRect(x, y, TILE, cw);
    if (!dn) sctx.fillRect(x, y + TILE - cw, TILE, cw);
    if (!lt) sctx.fillRect(x, y, cw, TILE);
    if (!rt) sctx.fillRect(x + TILE - cw, y, cw, TILE);
    // lane markings (skip on junctions for a clean intersection)
    if (links <= 2) {
      sctx.fillStyle = 'rgba(232,206,92,0.85)';
      const mw = Math.max(1, TILE * 0.05), mid = TILE / 2, step = TILE * 0.4;
      if (lt || rt) {
        const sx = lt ? x : x + mid, ex = rt ? x + TILE : x + mid;
        for (let px = sx; px < ex - 1; px += step)
          sctx.fillRect(px, y + mid - mw / 2, Math.min(TILE * 0.22, ex - px), mw);
      }
      if (up || dn) {
        const sy = up ? y : y + mid, ey = dn ? y + TILE : y + mid;
        for (let py = sy; py < ey - 1; py += step)
          sctx.fillRect(x + mid - mw / 2, py, mw, Math.min(TILE * 0.22, ey - py));
      }
    }
  }

  function drawService(x, y, tile, body, glyphCh, hideBadge) {
    const pad = TILE * 0.14, w = TILE - pad * 2, h = TILE - pad * 2;
    // shadow
    sctx.fillStyle = 'rgba(0,0,0,0.32)';
    roundRect(sctx, x + pad + TILE * 0.05, y + pad + TILE * 0.07, w, h, TILE * 0.14);
    sctx.fill();
    // body
    const grd = sctx.createLinearGradient(0, y + pad, 0, y + pad + h);
    grd.addColorStop(0, shade(body, 40));
    grd.addColorStop(1, body);
    sctx.fillStyle = grd;
    roundRect(sctx, x + pad, y + pad, w, h, TILE * 0.14);
    sctx.fill();
    // roof highlight band
    sctx.fillStyle = 'rgba(255,255,255,0.14)';
    roundRect(sctx, x + pad, y + pad, w, h * 0.34, TILE * 0.14);
    sctx.fill();
    glyph(glyphCh, x, y);
    if (!hideBadge && !tile.pwr) noPower(x, y);
  }

  const ZONE_PAL = {
    [T.RES]: { top: '#5fbf73', bot: '#2f7a44', roof: '#26603a', empty: 'rgba(81,207,102,0.16)', edge: '#3fae5a', letter: 'R' },
    [T.COM]: { top: '#5aa9e6', bot: '#2f6fa3', roof: '#27567e', empty: 'rgba(76,194,255,0.16)', edge: '#3f93d6', letter: 'C' },
    [T.IND]: { top: '#d8b24a', bot: '#937223', roof: '#6f5519', empty: 'rgba(255,212,59,0.16)', edge: '#c9a13a', letter: 'I' },
  };

  function drawZone(x, y, tile) {
    const P = ZONE_PAL[tile.t];

    if (tile.lvl === 0) {
      // zoned but undeveloped — tinted plot with dashed border + faint letter
      sctx.fillStyle = P.empty;
      roundRect(sctx, x + TILE * 0.12, y + TILE * 0.12, TILE * 0.76, TILE * 0.76, TILE * 0.08);
      sctx.fill();
      sctx.strokeStyle = P.edge;
      sctx.lineWidth = Math.max(1, TILE * 0.045);
      sctx.setLineDash([TILE * 0.14, TILE * 0.1]);
      roundRect(sctx, x + TILE * 0.15, y + TILE * 0.15, TILE * 0.7, TILE * 0.7, TILE * 0.08);
      sctx.stroke();
      sctx.setLineDash([]);
      sctx.fillStyle = 'rgba(255,255,255,0.35)';
      sctx.font = '600 ' + (TILE * 0.4) + 'px -apple-system, sans-serif';
      sctx.textAlign = 'center'; sctx.textBaseline = 'middle';
      sctx.fillText(P.letter, x + TILE / 2, y + TILE * 0.54);
      return;
    }

    const lv = tile.lvl;                       // 1..5
    const f = lv / MAX_LVL;                     // 0.2..1
    const inset = TILE * (0.2 - f * 0.08);      // larger footprint at higher level
    const bx = x + inset, bw = TILE - inset * 2;
    const lift = TILE * (0.08 + f * 0.52);      // taller with level
    const by = y + inset - lift + TILE * 0.08;  // top of building
    const groundY = y + TILE - inset;
    const bh = groundY - by;                    // wall height down to the ground

    // ground shadow
    sctx.fillStyle = 'rgba(0,0,0,0.28)';
    roundRect(sctx, bx + TILE * 0.1, groundY - TILE * 0.05, bw, TILE * 0.13, TILE * 0.05);
    sctx.fill();

    // wall (vertical gradient)
    const wg = sctx.createLinearGradient(0, by, 0, by + bh);
    wg.addColorStop(0, P.top);
    wg.addColorStop(1, P.bot);
    sctx.fillStyle = wg;
    sctx.fillRect(bx, by, bw, bh);
    // 3D edges: lit left, shaded right
    const edge = Math.max(1, bw * 0.12);
    sctx.fillStyle = 'rgba(255,255,255,0.1)';
    sctx.fillRect(bx, by, edge, bh);
    sctx.fillStyle = 'rgba(0,0,0,0.16)';
    sctx.fillRect(bx + bw - edge, by, edge, bh);

    // roof slab + parapet highlight
    sctx.fillStyle = P.roof;
    sctx.fillRect(bx, by, bw, Math.max(2, TILE * 0.12));
    sctx.fillStyle = 'rgba(255,255,255,0.14)';
    sctx.fillRect(bx, by, bw, Math.max(1, TILE * 0.03));
    if (lv >= 3) { // rooftop unit on taller buildings
      sctx.fillStyle = P.roof;
      sctx.fillRect(bx + bw * 0.55, by - TILE * 0.08, bw * 0.28, TILE * 0.08);
    }

    // windows — lit warm when powered, dark when not
    const cols = clamp(Math.round(lv * 0.8) + 1, 2, 4);
    const rows = clamp(lv, 1, 4);
    const padX = bw * 0.18, padTop = TILE * 0.16;
    const cellW = (bw - padX * 2) / cols;
    const cellH = (bh - padTop - bh * 0.14) / rows;
    const winW = Math.max(1.5, cellW * 0.55), winH = Math.max(1.5, cellH * 0.55);
    for (let wr = 0; wr < rows; wr++) {
      for (let wc = 0; wc < cols; wc++) {
        const seed = (wr * 3 + wc * 7 + lv * 5) % 5;
        const lit = tile.pwr && seed !== 0;
        sctx.fillStyle = lit ? 'rgba(255,224,150,0.92)'
                       : tile.pwr ? 'rgba(180,200,220,0.5)'
                       : 'rgba(38,52,68,0.72)';
        sctx.fillRect(bx + padX + wc * cellW + (cellW - winW) / 2,
                      by + padTop + wr * cellH + (cellH - winH) / 2, winW, winH);
      }
    }
    if (!tile.pwr) noPower(x, y);
  }

  function glyph(ch, x, y) {
    sctx.font = (TILE * 0.62) + 'px -apple-system, "Segoe UI Emoji", sans-serif';
    sctx.textAlign = 'center'; sctx.textBaseline = 'middle';
    sctx.fillText(ch, x + TILE / 2, y + TILE * 0.54);
  }

  // small red ⚡ badge in the tile's top-right corner
  function noPower(x, y) {
    const rad = Math.max(4, TILE * 0.16);
    const cx = x + TILE - rad - TILE * 0.04, cy = y + rad + TILE * 0.04;
    sctx.fillStyle = 'rgba(120,20,20,0.92)';
    sctx.beginPath(); sctx.arc(cx, cy, rad, 0, 7); sctx.fill();
    sctx.fillStyle = '#ffd6d6';
    sctx.font = (rad * 1.5) + 'px sans-serif';
    sctx.textAlign = 'center'; sctx.textBaseline = 'middle';
    sctx.fillText('⚡', cx, cy + rad * 0.05);
  }

  // live hover cursor drawn on the main canvas, on top of the buffer
  function drawHover() {
    if (hoverIdx < 0) return;
    const c = hoverIdx % GRID, r = (hoverIdx / GRID) | 0;
    const s = scrTile(), x = cam.x + c * s, y = cam.y + r * s;
    const bad = tool.id === 'bull';
    ctx.save();
    ctx.fillStyle = bad ? 'rgba(255,90,90,0.18)' : 'rgba(120,200,255,0.15)';
    ctx.fillRect(x, y, s, s);
    ctx.strokeStyle = bad ? 'rgba(255,120,120,0.95)' : 'rgba(160,220,255,0.95)';
    const lw = Math.max(1, s * 0.06);
    ctx.lineWidth = lw;
    ctx.strokeRect(x + lw / 2, y + lw / 2, s - lw, s - lw);
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

  // current SCREEN position of an agent (interpolated between tiles, + lane offset, + camera)
  function agentPixel(a) {
    const dx = a.nc - a.c, dy = a.nr - a.r;        // heading (unit or 0 when standing)
    const cx = a.c + 0.5 + dx * a.t, cy = a.r + 0.5 + dy * a.t;
    const t = scrTile();
    return { x: cam.x + (cx - dy * a.lane) * t, y: cam.y + (cy + dx * a.lane) * t, dx, dy };
  }

  function drawAgents() {
    if (!lifeOn) return;
    for (const m of marks) drawMark(m);
    for (const a of cars) drawCar(a);
    for (const a of dogs) drawDog(a);
    for (const a of peds) drawPed(a);
  }

  function drawMark(m) {
    const a = 1 - m.age / m.ttl;
    if (a <= 0) return;
    const s = scrTile();
    ctx.fillStyle = 'rgba(226,206,72,' + (0.3 * a).toFixed(3) + ')';
    ctx.beginPath();
    ctx.ellipse(cam.x + m.x * s, cam.y + m.y * s, s * 0.09, s * 0.05, 0, 0, 6.3);
    ctx.fill();
  }

  function drawPed(a) {
    const { x, y } = agentPixel(a), s = scrTile(), walking = a.state === 'walk';
    const bob = walking ? Math.abs(Math.sin(a.phase)) * s * 0.03 : 0;
    ctx.fillStyle = 'rgba(0,0,0,0.25)';
    ctx.beginPath(); ctx.ellipse(x, y, s * 0.1, s * 0.05, 0, 0, 6.3); ctx.fill();
    const sw = walking ? Math.sin(a.phase) * s * 0.06 : 0;        // leg swing
    ctx.strokeStyle = '#2b2f36'; ctx.lineWidth = Math.max(1, s * 0.04);
    ctx.beginPath();
    ctx.moveTo(x - s * 0.03, y - s * 0.03); ctx.lineTo(x - s * 0.03 + sw, y);
    ctx.moveTo(x + s * 0.03, y - s * 0.03); ctx.lineTo(x + s * 0.03 - sw, y);
    ctx.stroke();
    const by = y - s * 0.14 - bob;
    ctx.fillStyle = a.color;                                      // shirt
    roundRect(ctx, x - s * 0.07, by, s * 0.14, s * 0.14, s * 0.04); ctx.fill();
    ctx.fillStyle = a.skin;                                       // head
    ctx.beginPath(); ctx.arc(x, by - s * 0.04, s * 0.055, 0, 6.3); ctx.fill();
  }

  function drawDog(a) {
    let { x, y, dx, dy } = agentPixel(a); const s = scrTile(); let lift = 0, peeT = 0;
    if (a.state === 'pee') {
      x += a.peeOx * s * 0.35; y += a.peeOy * s * 0.35;           // shuffle toward the pole/kerb
      dx = a.peeOx; dy = a.peeOy; lift = 1; peeT = 1 - clamp(a.timer / 1.8, 0, 1);
    }
    if (dx === 0 && dy === 0) dx = 1;
    const ang = Math.atan2(dy, dx), L = s * 0.15, H = s * 0.08;
    ctx.save(); ctx.translate(x, y); ctx.rotate(ang);            // local +X = nose, -X = tail
    ctx.fillStyle = 'rgba(0,0,0,0.22)';
    ctx.beginPath(); ctx.ellipse(0, H * 0.8, L, H * 0.55, 0, 0, 6.3); ctx.fill();
    const sw = a.state === 'walk' ? Math.sin(a.phase) * s * 0.05 : 0;
    ctx.strokeStyle = a.fur2; ctx.lineWidth = Math.max(1, s * 0.03);
    ctx.beginPath();
    ctx.moveTo(L * 0.5, 0); ctx.lineTo(L * 0.5 + sw, H);          // front leg
    if (lift) { ctx.moveTo(-L * 0.5, 0); ctx.lineTo(-L * 0.95, -H * 0.7); }  // cocked hind leg
    else { ctx.moveTo(-L * 0.5, 0); ctx.lineTo(-L * 0.5 - sw, H); }
    ctx.stroke();
    ctx.fillStyle = a.fur;
    ctx.beginPath(); ctx.ellipse(0, 0, L, H, 0, 0, 6.3); ctx.fill();           // body
    ctx.beginPath(); ctx.arc(L * 0.85, -H * 0.35, H * 0.95, 0, 6.3); ctx.fill(); // head
    ctx.fillStyle = a.fur2;
    ctx.beginPath(); ctx.arc(L * 0.78, -H * 1.0, H * 0.4, 0, 6.3); ctx.fill();   // ear
    const wag = Math.sin(a.phase * 1.6) * 0.5;
    ctx.strokeStyle = a.fur; ctx.lineWidth = Math.max(1, s * 0.045);
    ctx.beginPath(); ctx.moveTo(-L * 0.9, -H * 0.2); ctx.lineTo(-L * 1.5, -H * 0.7 + wag * H); ctx.stroke(); // tail
    if (lift && peeT > 0.2) {                                     // the deed
      ctx.strokeStyle = 'rgba(240,222,84,0.85)'; ctx.lineWidth = Math.max(1, s * 0.025);
      ctx.beginPath(); ctx.moveTo(-L * 0.7, H * 0.1); ctx.lineTo(-L * 1.05 - H * 0.5, H * 1.15); ctx.stroke();
    }
    ctx.restore();
  }

  function drawCar(a) {
    const { x, y, dx, dy } = agentPixel(a), s = scrTile();
    const ang = Math.atan2(dy || 0, dx || 1), L = s * 0.36, W = s * 0.2;
    ctx.save(); ctx.translate(x, y); ctx.rotate(ang);
    ctx.fillStyle = 'rgba(0,0,0,0.28)'; roundRect(ctx, -L / 2 + s * 0.02, -W / 2 + s * 0.03, L, W, s * 0.05); ctx.fill();
    ctx.fillStyle = a.color; roundRect(ctx, -L / 2, -W / 2, L, W, s * 0.05); ctx.fill();
    ctx.fillStyle = 'rgba(220,240,255,0.4)'; roundRect(ctx, -L * 0.06, -W * 0.34, L * 0.32, W * 0.68, s * 0.03); ctx.fill();
    ctx.fillStyle = 'rgba(255,240,180,0.95)';                     // headlights (front)
    ctx.fillRect(L * 0.42, -W * 0.34, s * 0.035, W * 0.22);
    ctx.fillRect(L * 0.42, W * 0.12, s * 0.035, W * 0.22);
    ctx.restore();
  }

  // lamppost — drawn into the static city buffer (it's infrastructure, not "life")
  function drawPole(p) {
    const x = p.x * TILE, y = p.y * TILE, s = TILE;
    sctx.fillStyle = '#23262c'; sctx.fillRect(x - s * 0.045, y - s * 0.03, s * 0.09, s * 0.045);            // base
    sctx.fillStyle = '#2a2e35'; sctx.fillRect(x - Math.max(1, s * 0.018), y - s * 0.36, Math.max(1.5, s * 0.036), s * 0.36); // post
    sctx.fillStyle = '#3a3f47'; sctx.fillRect(x - s * 0.055, y - s * 0.42, s * 0.11, s * 0.07);             // lamp head
    sctx.fillStyle = 'rgba(255,224,150,0.55)';
    sctx.beginPath(); sctx.arc(x, y - s * 0.37, s * 0.05, 0, 6.3); sctx.fill();                              // glow
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

  function tileFromEvent(e) {
    const rect = canvas.getBoundingClientRect();
    const t = scrTile();
    const c = Math.floor(((e.clientX - rect.left) - cam.x) / t);
    const r = Math.floor(((e.clientY - rect.top)  - cam.y) / t);
    return inB(c, r) ? idx(c, r) : -1;
  }

  function place(i) {
    if (i < 0 || i === lastPaint) return;
    lastPaint = i;
    const tile = map[i];

    if (tool.id === 'bull') {
      if (tile.t === T.GRASS) return;
      if (tile.t === T.WATER) { setHint("Can't bulldoze water."); return; }
      if (money < tool.cost) { brokeHint(); return; }
      money -= tool.cost;
      tile.t = T.GRASS; tile.lvl = 0; tile.pwr = false;
      afterEdit();
      return;
    }

    // can't build on water (except nothing); building over existing pays again only if different
    if (tile.t === T.WATER) { setHint("That's water — bridges aren't in this version."); return; }
    if (tile.t === tool.type && !isZone(tool.type)) return; // already that
    if (tile.t === tool.type && isZone(tool.type)) return;  // already zoned same

    if (money < tool.cost) { brokeHint(); return; }
    money -= tool.cost;
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
    place(tileFromEvent(e));
  });
  window.addEventListener('mouseup', () => {
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
    const t0 = scrTile();
    const wx = (sx - cam.x) / t0, wy = (sy - cam.y) / t0;     // world tile under cursor
    cam.zoom = clamp(cam.zoom * Math.exp(-e.deltaY * 0.0015), 1, Z_MAX);
    const t1 = scrTile();
    cam.x = sx - wx * t1; cam.y = sy - wy * t1;               // keep that point under the cursor
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
    const rect = canvas.parentElement.getBoundingClientRect();
    tooltip.style.left = (e.clientX - rect.left + 14) + 'px';
    tooltip.style.top = (e.clientY - rect.top + 14) + 'px';
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
