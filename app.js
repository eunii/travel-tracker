"use strict";

/* APP_MODE is set by an inline <script> in focus.html / overview.html before this
   file loads. 'overview' = camera stays fixed on the whole-trip view; only the
   traveling marker moves. Anything else (or unset) = original camera-follow behavior. */
const OVERVIEW_MODE = (window.APP_MODE === 'overview');

/* ============ State ============ */
let allPhotos = [];        // {file,url,lat,lon,time,w,h}
let clusters = [];         // ordered chronologically {lat,lon,photos[],rep,startTime,endTime}
let markers = [];
let placeChips = [];  // sidebar breadcrumb chips, indexed like markers[]
let activeCluster = null;
let map = null;
let movingMarker = null;
let movingIconType = 'airplane';
let pathColor = '#8b93a7';       // full / upcoming route (dashed)
let progressColor = '#3ecf8e';   // traveled line + marker icon
// Lucide paths (same shapes as lucide-animated.com)
const MARKER_ICON_PATHS = {
  airplane: '<path d="M17.8 19.2 16 11l3.5-3.5C21 6 21.5 4 21 3c-1-.5-3 0-4.5 1.5L13 8 4.8 6.2c-.5-.1-.9.1-1.1.5l-.3.5c-.2.5-.1 1 .3 1.3L9 12l-2 3H4l-1 1 3 2 2 3 1-1v-3l3-2 3.5 5.3c.3.4.8.5 1.3.3l.5-.2c.4-.3.6-.7.5-1.2z"/>',
  'chess-king': '<path d="M4 20a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v1a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1z"/><path d="m6.7 18-1-1C4.35 15.682 3 14.09 3 12a5 5 0 0 1 4.95-5c1.584 0 2.7.455 4.05 1.818C13.35 7.455 14.466 7 16.05 7A5 5 0 0 1 21 12c0 2.082-1.359 3.673-2.7 5l-1 1"/><path d="M10 4h4"/><path d="M12 2v6.818"/>',
  heart: '<path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z"/>',
  moon: '<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>',
  rabbit: '<path d="M13 16a3 3 0 0 1 2.24 5"/><path d="M18 12h.01"/><path d="M18 21h-8a4 4 0 0 1-4-4 7 7 0 0 1 7-7h.2L9.6 6.4a1 1 0 1 1 2.8-2.8L15.8 7h.2c3.3 0 6 2.7 6 6v1a2 2 0 0 1-2 2h-1a3 3 0 0 0-3 3"/><path d="M20 8.54V4a2 2 0 1 0-4 0v3"/><path d="M7.612 12.524a3 3 0 1 0-1.6 4.3"/>',
  ship: '<path d="M12 10.189V14"/><path d="M12 2v3"/><path d="M19 13V7a2 2 0 0 0-2-2H7a2 2 0 0 0-2 2v6"/><path d="M19.38 20A11.6 11.6 0 0 0 21 14l-8.188-3.639a2 2 0 0 0-1.624 0L3 14a11.6 11.6 0 0 0 2.81 7.76"/><path d="M2 21c.6.5 1.2 1 2.5 1 2.5 0 2.5-2 5-2 1.3 0 1.9.5 2.5 1s1.2 1 2.5 1c2.5 0 2.5-2 5-2 1.3 0 1.9.5 2.5 1"/>',
  smile: '<circle cx="12" cy="12" r="10"/><path d="M8 14s1.5 2 4 2 4-2 4-2"/><line x1="9" x2="9.01" y1="9" y2="9"/><line x1="15" x2="15.01" y1="9" y2="9"/>',
  truck: '<path d="M14 18V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v11a1 1 0 0 0 1 1h2"/><path d="M15 18H9"/><path d="M19 18h2a1 1 0 0 0 1-1v-3.65a1 1 0 0 0-.22-.624l-3.48-4.35A1 1 0 0 0 17.52 8H14"/><circle cx="17" cy="18" r="2"/><circle cx="7" cy="18" r="2"/>',
  users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>'
};
const MARKER_ICON_LABELS = {
  airplane: '비행기', 'chess-king': '킹', heart: '하트', moon: '달', rabbit: '토끼',
  ship: '배', smile: '스마일', truck: '트럭', users: '사람들'
};
function iconSvgHtml(name, size){
  size = size || 20;
  const inner = MARKER_ICON_PATHS[name];
  if (!inner) return '';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;
}
let segDurations = [];     // ms per travel hop at speed=1
let segDwells = [];        // ms per place dwell (arrival hold)
let segKm = [];            // hop distance km
let segLong = [];          // long-hop flag for mid zoom-out
let segNear = [];          // near hop (km): soft lead / arrival hints
let segHopZoom = [];       // hopFit zoom per hop (A→B)
let segTight = [];         // hopFit needs more zoom than baseZoom
let segWindowZoom = [];    // fit A→B→next for stable local cruise
let segLocal = [];         // use windowZoom instead of baseZoom
let baseZoom = 10;         // trip-wide cruise zoom
let arrivalZoom = 11;      // base * 1.08
let overviewZoom = 6;
let overviewLon = 127.5;
let overviewLat = 36.5;
let camZoom = null;
let camLon = null;
let camLat = null;
let camFollow = (OVERVIEW_MODE ? false : true);
let animElapsed = 0;
let animTotal = 0;
let arrivalBubbleLabel = null;
let lastCamPhaseKey = null;
let lastSlideKey = null;
let lastPopPinIdx = null;
let isPlaying = false;
let isRecording = false;
let lastFrameTs = null;
let rafId = null;
let lightboxPhotos = [];
let lightboxIndex = 0;
let arrivalMode = 'move';
let playIntroTimer = null;
let cineMode = 'idle';      // idle | intro | main | outro
let cineStage = 0;
let cineElapsed = 0;
let spotCardState = null;  // DOM overlay state (photo slide while playing)
let dayBannerText = null;

const CAM_MIN_ZOOM = 3;
const CAM_MAX_ZOOM = 15;
const CAM_ZOOM_OUT_RATE = 1.6;
const CAM_ZOOM_IN_RATE = 1.8;
const CAM_CENTER_BLEND = 0.18;
const CAM_ZOOM_DEADBAND = 0.04;
const DWELL_MS = 700;
const SLIDE_MS = 650;
const PHOTO_SLIDE_MAX = 6;
const INTRO_OVERVIEW_MS = 2200;
const INTRO_ZOOM_MS = 600;
const INTRO_HOLD_MS = 350;
const OUTRO_HOLD_MS = 400;
const OUTRO_ZOOM_MS = 750;
const ARRIVAL_ZOOM_FACTOR = 1.08;
const NEAR_HOP_KM = 2;
const LONG_HOP_KM = 80;
const LONG_HOP_OUT = 0.85;
const LEAD_FRAC = 0.10;
const TIGHT_HOP_DELTA = 0.35;
const LS_ARRIVAL_MODE = 'travel-tracker-arrival-mode';
const LS_PHOTO_FAN_LEGACY = 'travel-tracker-photo-fan';
const LS_TRIP_TITLE = 'travel-tracker-trip-title';

let tripTitleCustom = null;
try {
  const savedTitle = localStorage.getItem(LS_TRIP_TITLE);
  if (savedTitle != null && savedTitle !== '') tripTitleCustom = savedTitle;
} catch (e) { /* ignore */ }

let topProgressState = null;
let tripIntroVisible = false;

const $ = (id) => document.getElementById(id);

/* ============ Map init ============ */
const BASEMAP_TILES = {
  dark: ['a','b','c','d'].map(s => `https://${s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png`),
  light: ['a','b','c','d'].map(s => `https://${s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png`)
};
let mapTheme = 'light';
function buildMapStyle(theme){
  return {
    version: 8,
    sources: {
      basemap: {
        type: 'raster',
        tiles: BASEMAP_TILES[theme],
        tileSize: 256,
        maxzoom: 20,
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>'
      }
    },
    layers: [{ id: 'basemap', type: 'raster', source: 'basemap' }]
  };
}

class ThemeToggleControl {
  onAdd(){
    this._container = document.createElement('div');
    this._container.className = 'maplibregl-ctrl maplibregl-ctrl-group theme-toggle-ctrl';
    this._btn = document.createElement('button');
    this._btn.type = 'button';
    this._btn.title = '지도 밝기 전환';
    this._btn.textContent = mapTheme === 'dark' ? '☀️' : '🌙';
    this._btn.addEventListener('click', () => {
      mapTheme = mapTheme === 'dark' ? 'light' : 'dark';
      this._btn.textContent = mapTheme === 'dark' ? '☀️' : '🌙';
      // full replace so custom route sources/layers are cleared cleanly, then
      // restored from the style.load → restoreRouteAfterStyle handler
      map.setStyle(buildMapStyle(mapTheme), { diff: false });
    });
    this._container.appendChild(this._btn);
    return this._container;
  }
  onRemove(){ this._container.parentNode.removeChild(this._container); }
}

/** Line paint: dashed overall path vs solid traveled progress. */
function routePaint(){
  if (mapTheme === 'light'){
    return {
      full: { 'line-color': pathColor, 'line-width':2.5, 'line-dasharray':[2,2], 'line-opacity':0.75 },
      progress: { 'line-color': progressColor, 'line-width':4.5, 'line-opacity':1 }
    };
  }
  return {
    full: { 'line-color': pathColor, 'line-width':2, 'line-dasharray':[2,2], 'line-opacity':0.55 },
    progress: { 'line-color': progressColor, 'line-width':4, 'line-opacity':0.95 }
  };
}

function ensureRouteLayer(id, sourceId, paint){
  if (!map.getSource(sourceId)){
    map.addSource(sourceId, { type:'geojson', data: emptyLine() });
  }
  if (!map.getLayer(id)){
    map.addLayer({ id, type:'line', source: sourceId, paint });
  } else {
    for (const [key, val] of Object.entries(paint)){
      try { map.setPaintProperty(id, key, val); } catch (e) { /* ignore */ }
    }
  }
}

function setupRouteLayers(){
  const paint = routePaint();
  ensureRouteLayer('route-full-line', 'route-full', paint.full);
  ensureRouteLayer('route-progress-line', 'route-progress', paint.progress);
}

/** Re-attach GeoJSON route after setStyle wipes custom sources/layers. */
function restoreRouteAfterStyle(){
  setupRouteLayers();
  if (!clusters.length) return;
  renderRoute();
  if (animTotal > 0) renderFrame(animElapsed);
}

function mapPadding(){
  const leftPad = isMobile() ? 80 : 380;
  return { top:80, bottom:100, left:leftPad, right:80 };
}

/** Tighter padding for playback camera so local hops aren't forced too far out. */
function playPadding(){
  return { top:72, bottom:72, left:72, right:72 };
}

/** Zoom level that fits both points (clamped). Call only when camera is stable (e.g. computeSegments). */
function zoomToFitPoints(a, b, padding){
  if (!map) return 12;
  padding = padding || playPadding();
  const same = Math.abs(a.lat - b.lat) < 1e-7 && Math.abs(a.lon - b.lon) < 1e-7;
  if (same) return CAM_MAX_ZOOM;
  const bounds = new maplibregl.LngLatBounds([a.lon, a.lat], [b.lon, b.lat]);
  try {
    const cam = map.cameraForBounds(bounds, { padding, maxZoom: CAM_MAX_ZOOM });
    if (cam && typeof cam.zoom === 'number'){
      return Math.max(CAM_MIN_ZOOM, Math.min(CAM_MAX_ZOOM, cam.zoom));
    }
  } catch (e) { /* fall through */ }
  const km = haversine(a.lat, a.lon, b.lat, b.lon) / 1000;
  const z = 14.5 - Math.log2(Math.max(km, 0.05) * 2);
  return Math.max(CAM_MIN_ZOOM, Math.min(CAM_MAX_ZOOM, z));
}

/** Zoom + center that fit both hop endpoints (kept for misc; playback uses baseZoom). */
function hopFitCamera(a, b){
  const pad = playPadding();
  const mid = { lon: (a.lon + b.lon) / 2, lat: (a.lat + b.lat) / 2 };
  const same = Math.abs(a.lat - b.lat) < 1e-7 && Math.abs(a.lon - b.lon) < 1e-7;
  if (same) return { zoom: CAM_MAX_ZOOM, lon: a.lon, lat: a.lat };
  let z = 12;
  let lon = mid.lon, lat = mid.lat;
  const bounds = new maplibregl.LngLatBounds([a.lon, a.lat], [b.lon, b.lat]);
  try {
    const cam = map.cameraForBounds(bounds, { padding: pad, maxZoom: CAM_MAX_ZOOM });
    if (cam && typeof cam.zoom === 'number'){
      z = cam.zoom;
      if (cam.center){ lon = cam.center.lng; lat = cam.center.lat; }
    } else {
      z = zoomToFitPoints(a, b, pad);
    }
  } catch (e) {
    z = zoomToFitPoints(a, b, pad);
  }
  z = Math.max(CAM_MIN_ZOOM, Math.min(CAM_MAX_ZOOM, z));
  return { zoom: z, lon, lat };
}

/** Zoom that fits 2+ points (departure / arrival / optional next). */
function fitPointsZoom(points){
  const pts = (points || []).filter(Boolean);
  if (!pts.length) return baseZoom;
  if (pts.length === 1) return Math.min(CAM_MAX_ZOOM, Math.max(baseZoom, arrivalZoom));
  if (pts.length === 2) return hopFitCamera(pts[0], pts[1]).zoom;
  const pad = playPadding();
  const bounds = new maplibregl.LngLatBounds([pts[0].lon, pts[0].lat], [pts[0].lon, pts[0].lat]);
  for (let i = 1; i < pts.length; i++) bounds.extend([pts[i].lon, pts[i].lat]);
  try {
    const cam = map.cameraForBounds(bounds, { padding: pad, maxZoom: CAM_MAX_ZOOM });
    if (cam && typeof cam.zoom === 'number'){
      return Math.max(CAM_MIN_ZOOM, Math.min(CAM_MAX_ZOOM, cam.zoom));
    }
  } catch (e) { /* fall through */ }
  let z = CAM_MAX_ZOOM;
  for (let i = 0; i < pts.length - 1; i++){
    z = Math.min(z, hopFitCamera(pts[i], pts[i + 1]).zoom);
  }
  return Math.max(CAM_MIN_ZOOM, Math.min(CAM_MAX_ZOOM, z));
}

function captureOverviewCamera(){
  const padding = mapPadding();
  if (!clusters.length) return;
  if (clusters.length === 1){
    overviewZoom = 13;
    overviewLon = clusters[0].lon;
    overviewLat = clusters[0].lat;
    return;
  }
  const b = new maplibregl.LngLatBounds();
  clusters.forEach(c => b.extend([c.lon, c.lat]));
  try {
    const cam = map.cameraForBounds(b, { padding, maxZoom: CAM_MAX_ZOOM });
    if (cam){
      overviewZoom = cam.zoom;
      overviewLon = cam.center.lng;
      overviewLat = cam.center.lat;
    }
  } catch (e) { /* keep previous */ }
}

function computeTripBaseZoom(){
  captureOverviewCamera();
  // Cruise a bit tighter than full-trip overview so travel feels intimate
  baseZoom = Math.min(CAM_MAX_ZOOM, Math.max(CAM_MIN_ZOOM, overviewZoom + 1.35));
  arrivalZoom = Math.min(CAM_MAX_ZOOM, baseZoom * ARRIVAL_ZOOM_FACTOR);
}

function hopDurationMs(km){
  // Soft sqrt curve for short/medium hops; speed cap so very long hops aren't a blink.
  const fromSqrt = 1.25 + Math.sqrt(Math.max(0, km)) * 0.42;
  const fromSpeedCap = km / 70; // at most ~70 km per playback-second
  const sec = Math.max(1.2, Math.min(5.0, Math.max(fromSqrt, fromSpeedCap)));
  return sec * 1000;
}

/** cubic-bezier(0.45, 0, 0.2, 1) */
function easeTravel(t){
  t = Math.max(0, Math.min(1, t));
  const x1 = 0.45, y1 = 0, x2 = 0.2, y2 = 1;
  let x = t;
  for (let i = 0; i < 6; i++){
    const u = 1 - x;
    const cx = 3 * u * u * x1 + 6 * u * x * x2 + 3 * x * x;
    if (Math.abs(cx) < 1e-6) break;
    const bx = 3 * u * u * x * x1 + 3 * u * x * x * x2 + x * x * x - t;
    x -= bx / cx;
  }
  x = Math.max(0, Math.min(1, x));
  const u = 1 - x;
  return 3 * u * u * x * y1 + 3 * u * x * x * y2 + x * x * x;
}

function bearingRad(a, b){
  const φ1 = a.lat * Math.PI / 180, φ2 = b.lat * Math.PI / 180;
  const Δλ = (b.lon - a.lon) * Math.PI / 180;
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return Math.atan2(y, x);
}

/** Shift camera center along travel so the traveler sits ~40–45% opposite the heading. */
function leadRoomCenter(lon, lat, from, to, leadAmt){
  if (!map || leadAmt <= 0.01 || !from || !to) return { lon, lat };
  const br = bearingRad(from, to);
  const w = map.getContainer().clientWidth;
  const h = map.getContainer().clientHeight;
  const px = Math.min(w, h) * LEAD_FRAC * leadAmt;
  const p = map.project([lon, lat]);
  const ox = Math.sin(br) * px;
  const oy = -Math.cos(br) * px;
  const ll = map.unproject([p.x + ox, p.y + oy]);
  return { lon: ll.lng, lat: ll.lat };
}

function jumpToFirstSpot(){
  if (!clusters.length) return;
  camLon = clusters[0].lon;
  camLat = clusters[0].lat;
  camZoom = arrivalZoom || baseZoom;
  map.jumpTo({ center: [camLon, camLat], zoom: camZoom });
}

function placeTitle(c){
  if (!c) return '';
  const idx = clusters.indexOf(c);
  return c.customName || c.placeName || `장소 ${idx >= 0 ? idx + 1 : '?'}`;
}

function defaultTripTitle(){
  if (!clusters.length) return '나의 여행';
  return placeTitle(clusters[0]) + ' 여행';
}

function getTripTitle(){
  if (tripTitleCustom != null && String(tripTitleCustom).trim() !== '') return String(tripTitleCustom).trim();
  return defaultTripTitle();
}

function setTripTitleCustom(val){
  const t = val == null ? '' : String(val).trim();
  if (!t){
    tripTitleCustom = null;
    try { localStorage.removeItem(LS_TRIP_TITLE); } catch (e) { /* ignore */ }
  } else {
    tripTitleCustom = t;
    try { localStorage.setItem(LS_TRIP_TITLE, t); } catch (e) { /* ignore */ }
  }
  refreshTripTitleUI();
}

function tripStayLabel(){
  if (!clusters.length) return { en: 'DAY TRIP', ko: '당일', n: 0 };
  const n = new Set(clusters.map(c => c.day)).size;
  if (n <= 1) return { en: 'DAY TRIP', ko: '당일', n: 1 };
  return { en: n + ' DAYS', ko: (n - 1) + '박 ' + n + '일', n };
}

function tripDateRangeLabel(){
  if (!clusters.length) return '-';
  const first = clusters[0].startTime;
  const last = clusters[clusters.length - 1].startTime;
  const a = fmtDateShort(first);
  if (!(last instanceof Date) || isNaN(last) || dateKey(first) === dateKey(last)) return a;
  if (first.getFullYear() === last.getFullYear()){
    return a + ' – ' + String(last.getMonth() + 1).padStart(2, '0') + '.' + String(last.getDate()).padStart(2, '0');
  }
  return a + ' – ' + fmtDateShort(last);
}

function refreshTripTitleUI(){
  const el = $('tripTitleLabel');
  if (el) el.textContent = getTripTitle();
  const ti = $('tiTitle');
  if (ti) ti.textContent = getTripTitle();
}

function tripDayLabel(){
  return tripStayLabel().en;
}

function tripStraightKm(){
  let m = 0;
  for (let i = 0; i < clusters.length - 1; i++){
    m += haversine(clusters[i].lat, clusters[i].lon, clusters[i + 1].lat, clusters[i + 1].lon);
  }
  return m / 1000;
}

function setArrivalBubble(text){
  arrivalBubbleLabel = text || null;
  if (!movingMarker) return;
  const el = movingMarker.getElement();
  let bubble = el.querySelector('.arrival-bubble');
  if (!text){
    if (bubble) bubble.remove();
    return;
  }
  if (!bubble){
    bubble = document.createElement('div');
    bubble.className = 'arrival-bubble';
    el.appendChild(bubble);
  }
  bubble.textContent = text;
}

function hideSpotCard(){
  spotCardState = null;
  lastSlideKey = null;
  const el = $('spotCard');
  if (!el) return;
  el.classList.remove('show', 'has-photo');
  el.setAttribute('aria-hidden', 'true');
  const photoEl = $('scPhoto');
  if (photoEl){
    photoEl.classList.remove('swap');
    photoEl.style.backgroundImage = '';
  }
}

function clearSpotCardPhoto(){
  hideSpotCard();
}

function showSpotCardPhoto(cluster, clusterIdx, dwellT){
  if (arrivalMode !== 'popup' || !cluster){
    hideSpotCard();
    return;
  }
  const photos = slidePhotosForCluster(cluster);
  if (!photos.length){
    hideSpotCard();
    return;
  }
  const slideIdx = Math.min(photos.length - 1, Math.floor(Math.min(0.999, Math.max(0, dwellT)) * photos.length));
  const photo = photos[slideIdx];
  const key = clusterIdx + ':' + slideIdx;
  const el = $('spotCard');
  const photoEl = $('scPhoto');
  const countEl = $('scSlideCount');
  if (!el || !photoEl || !countEl) return;

  const order = String(clusterIdx + 1).padStart(2, '0') + ' / ' + String(clusters.length).padStart(2, '0');
  const name = placeTitle(cluster);
  const timeStr = fmtDateTime(cluster.startTime);
  spotCardState = {
    order, name, time: timeStr,
    photos: cluster.photos.length, idx: clusterIdx,
    photoUrl: photo.url, slideIndex: slideIdx, slideTotal: photos.length
  };

  el.classList.add('show', 'has-photo');
  el.setAttribute('aria-hidden', 'false');
  countEl.textContent = (slideIdx + 1) + ' / ' + photos.length;

  if (lastSlideKey === key) return;
  const prevKey = lastSlideKey;
  lastSlideKey = key;
  if (prevKey != null && String(prevKey).split(':')[0] === String(clusterIdx)){
    photoEl.classList.add('swap');
    requestAnimationFrame(() => {
      photoEl.style.backgroundImage = `url(${photo.url})`;
      photoEl.classList.remove('swap');
    });
  } else {
    photoEl.classList.remove('swap');
    photoEl.style.backgroundImage = `url(${photo.url})`;
  }
}

function hideTopProgress(){
  topProgressState = null;
  const el = $('topProgress');
  if (!el) return;
  el.classList.remove('show', 'swap');
  el.setAttribute('aria-hidden', 'true');
}

function showTopProgress(cluster, idx){
  if (!cluster){ hideTopProgress(); return; }
  const el = $('topProgress');
  if (!el) return;
  const dayNum = cluster.day;
  const order = 'DAY ' + dayNum;
  const name = placeTitle(cluster); // kept for the canvas-export card, which stays single-line
  const prevIdx = topProgressState ? topProgressState.idx : null;
  topProgressState = { order, name, idx, day: dayNum };
  $('tpOrder').textContent = order;

  // Breadcrumb of every place visited/upcoming today, current one highlighted — built with
  // DOM nodes (not innerHTML string interpolation) since place names come from user input
  // or reverse-geocoding.
  const nameEl = $('tpName');
  nameEl.innerHTML = '';
  clusters.filter(c => c.day === dayNum).forEach((c, i) => {
    if (i > 0){
      const sep = document.createElement('span');
      sep.className = 'crumb-sep';
      sep.textContent = '›';
      nameEl.appendChild(sep);
    }
    const crumb = document.createElement('span');
    crumb.className = 'crumb' + (c === cluster ? ' active' : '');
    crumb.textContent = placeTitle(c);
    nameEl.appendChild(crumb);
  });

  const already = el.classList.contains('show');
  if (already && prevIdx != null && prevIdx !== idx){
    el.classList.add('swap');
    requestAnimationFrame(() => {
      el.classList.remove('swap');
      el.classList.add('show');
    });
  } else {
    el.classList.add('show');
  }
  el.setAttribute('aria-hidden', 'false');
}

function hideTripIntro(){
  tripIntroVisible = false;
  const el = $('tripIntro');
  if (!el) return;
  el.classList.remove('show');
  el.setAttribute('aria-hidden', 'true');
}

function showTripIntro(){
  tripIntroVisible = true;
  const el = $('tripIntro');
  if (!el) return;
  const stay = tripStayLabel();
  $('tiTitle').textContent = getTripTitle();
  $('tiDays').textContent = stay.n > 1 ? stay.ko + ' · ' + stay.en : stay.en;
  $('tiRange').textContent = tripDateRangeLabel();
  el.classList.add('show');
  el.setAttribute('aria-hidden', 'false');
}

function hideDayBanner(){
  dayBannerText = null;
  const el = $('dayBanner');
  if (!el) return;
  el.classList.remove('show');
  el.setAttribute('aria-hidden', 'true');
}

function showDayBanner(text){
  dayBannerText = text;
  const el = $('dayBanner');
  if (!el) return;
  el.textContent = text;
  el.classList.add('show');
  el.setAttribute('aria-hidden', 'false');
}

let endSummaryTimer = null;

function hideEndSummary(){
  if (endSummaryTimer){ clearTimeout(endSummaryTimer); endSummaryTimer = null; }
  const el = $('endSummary');
  if (!el) return;
  el.classList.remove('show');
  el.setAttribute('aria-hidden', 'true');
}

function showEndSummary(){
  const el = $('endSummary');
  if (!el) return;
  $('esSpots').textContent = String(clusters.length);
  $('esPhotos').textContent = String(allPhotos.length || clusters.reduce((s, c) => s + c.photos.length, 0));
  $('esDays').textContent = tripDayLabel();
  const km = tripStraightKm();
  $('esKm').textContent = km < 10 ? km.toFixed(1) : String(Math.round(km));
  el.classList.add('show');
  el.setAttribute('aria-hidden', 'false');
  if (endSummaryTimer) clearTimeout(endSummaryTimer);
  endSummaryTimer = setTimeout(hideEndSummary, 5000);
}

function popPinAt(idx){
  if (idx == null || idx < 0 || !markers[idx]) return;
  if (lastPopPinIdx === idx) return;
  lastPopPinIdx = idx;
  const pin = markers[idx]._el && markers[idx]._el.querySelector('.pin');
  if (!pin) return;
  pin.classList.remove('pop-in');
  void pin.offsetWidth;
  pin.classList.add('pop-in');
}

function slidePhotosForCluster(cluster){
  if (!cluster || !cluster.photos || !cluster.photos.length) return [];
  return cluster.photos.slice(0, PHOTO_SLIDE_MAX);
}

function dwellMsForCluster(c){
  if (arrivalMode !== 'popup' || !c) return DWELL_MS;
  const n = Math.max(1, slidePhotosForCluster(c).length);
  return Math.max(DWELL_MS, n * SLIDE_MS);
}

function syncMovingMarkerPlaying(){
  if (!movingMarker) return;
  movingMarker.getElement().classList.toggle('playing', isPlaying || isRecording);
}

/**
 * Timeline: dwell0 → travel0 → dwell1 → travel1 → … → dwell(n-1)
 */
function phaseAtElapsed(elapsed){
  elapsed = Math.max(0, Math.min(animTotal || 0, elapsed));
  const n = clusters.length;
  if (n < 2 || !segDurations.length){
    return { kind: 'dwell', clusterIdx: 0, segIdx: 0, t: 0 };
  }
  let acc = 0;
  for (let i = 0; i < n; i++){
    const dwell = segDwells[i] != null ? segDwells[i] : DWELL_MS;
    if (elapsed < acc + dwell || i === n - 1){
      const t = dwell > 0 ? Math.min(1, Math.max(0, (elapsed - acc) / dwell)) : 1;
      return { kind: 'dwell', clusterIdx: i, segIdx: Math.min(i, n - 2), t };
    }
    acc += dwell;
    const travelMs = segDurations[i] || 0;
    if (elapsed < acc + travelMs){
      const t = travelMs > 0 ? Math.min(1, (elapsed - acc) / travelMs) : 1;
      return { kind: 'travel', clusterIdx: i, segIdx: i, t };
    }
    acc += travelMs;
  }
  return { kind: 'dwell', clusterIdx: n - 1, segIdx: Math.max(0, n - 2), t: 1 };
}

function initMap(){
  map = new maplibregl.Map({
    container: 'map',
    attributionControl: false,
    style: buildMapStyle(mapTheme),
    center: [127.5, 36.5],
    zoom: 6,
    // needed so WebGL frames can be copied into the export canvas
    preserveDrawingBuffer: true
  });
  map.addControl(new maplibregl.NavigationControl(), 'top-right');
  map.addControl(new ThemeToggleControl(), 'top-right');
  map.addControl(new maplibregl.AttributionControl({compact:true}), 'top-right');

  map.on('load', setupRouteLayers);
  // setStyle removes custom sources/layers; restore route data on every style load
  map.on('style.load', restoreRouteAfterStyle);

  // user pan/zoom interrupts auto camera follow (playback continues)
  const stopFollow = () => { if (camFollow) camFollow = false; };
  map.on('dragstart', stopFollow);
  map.on('zoomstart', (e) => { if (e.originalEvent) stopFollow(); });
  map.on('rotatestart', stopFollow);
  map.on('pitchstart', stopFollow);
}
function emptyLine(){ return { type:'Feature', geometry:{ type:'LineString', coordinates:[] }, properties:{} }; }

/* ============ Mobile sidebar drawer ============ */
function openSidebar(){ $('sidebar').classList.add('open'); $('backdrop').classList.add('show'); }
function closeSidebar(){ $('sidebar').classList.remove('open'); $('backdrop').classList.remove('show'); }
$('sidebarToggle').addEventListener('click', openSidebar);
$('sidebarClose').addEventListener('click', closeSidebar);
$('backdrop').addEventListener('click', closeSidebar);
const isMobile = () => window.innerWidth <= 820;

/* drag the whole sidebar open/closed: swipe its header to close, swipe in from the
   left screen edge to open. Direction-locked so it never fights list scrolling. */
(function setupSidebarDrag(){
  const sidebar = $('sidebar'), backdrop = $('backdrop'), handle = sidebar.querySelector('h1');
  const EDGE = 24;
  let dragging = false, locked = null, startX = 0, startY = 0, baseX = 0, sidebarW = 0;

  function begin(x, y, fromOpen){
    sidebarW = sidebar.offsetWidth;
    baseX = fromOpen ? 0 : -sidebarW;
    startX = x; startY = y;
    dragging = true; locked = null;
    sidebar.style.transition = 'none';
    backdrop.style.display = 'block';
  }
  function move(x, y){
    if (!dragging) return false;
    const dx = x - startX, dy = y - startY;
    if (locked === null){
      if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return false;
      locked = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
      if (locked === 'y'){ dragging = false; sidebar.style.transition = ''; backdrop.style.display = ''; return false; }
    }
    const pos = Math.max(-sidebarW, Math.min(0, baseX + dx));
    sidebar.style.transform = `translateX(${pos}px)`;
    backdrop.style.opacity = String(1 + pos / sidebarW);
    return true;
  }
  function end(x){
    if (!dragging) return;
    dragging = false;
    const dx = x - startX;
    const pos = Math.max(-sidebarW, Math.min(0, baseX + dx));
    sidebar.style.transition = '';
    sidebar.style.transform = '';
    backdrop.style.opacity = '';
    backdrop.style.display = '';
    if (pos > -sidebarW * 0.5) openSidebar(); else closeSidebar();
  }

  handle.addEventListener('touchstart', e => {
    if (!isMobile() || !sidebar.classList.contains('open')) return;
    begin(e.touches[0].clientX, e.touches[0].clientY, true);
  }, {passive:true});
  document.addEventListener('touchstart', e => {
    if (!isMobile() || sidebar.classList.contains('open')) return;
    const t = e.touches[0];
    if (t.clientX <= EDGE) begin(t.clientX, t.clientY, false);
  }, {passive:true});
  document.addEventListener('touchmove', e => {
    if (!dragging) return;
    const t = e.touches[0];
    if (move(t.clientX, t.clientY)) e.preventDefault();
  }, {passive:false});
  document.addEventListener('touchend', e => { if (dragging) end(e.changedTouches[0].clientX); });
  document.addEventListener('touchcancel', () => {
    if (!dragging) return;
    dragging = false;
    sidebar.style.transition = ''; sidebar.style.transform = '';
    backdrop.style.opacity = ''; backdrop.style.display = '';
  });
})();
if (/iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream){
  $('iosHint').style.display = 'block';
}
if (isMobile()) openSidebar(); // 처음엔 열어서 안내가 보이게

/* ============ File intake: folder picker ============ */
$('btnFolder').addEventListener('click', () => $('folderInput').click());
$('btnFiles').addEventListener('click', () => $('filesInput').click());
$('folderInput').addEventListener('change', e => handleFileList([...e.target.files]));
$('filesInput').addEventListener('change', e => handleFileList([...e.target.files]));

const dropzone = $('dropzone');
['dragenter','dragover'].forEach(ev => dropzone.addEventListener(ev, e => {
  e.preventDefault(); dropzone.classList.add('drag');
}));
['dragleave','drop'].forEach(ev => dropzone.addEventListener(ev, e => {
  e.preventDefault(); dropzone.classList.remove('drag');
}));
dropzone.addEventListener('drop', async e => {
  const items = e.dataTransfer.items;
  if (items && items.length && items[0].webkitGetAsEntry) {
    const files = await getAllFileEntries(items);
    handleFileList(files);
  } else {
    handleFileList([...e.dataTransfer.files]);
  }
});
dropzone.addEventListener('click', () => $('folderInput').click());

function readAllEntries(reader){
  return new Promise((resolve, reject) => {
    let all = [];
    function step(){
      reader.readEntries(entries => {
        if (entries.length === 0) resolve(all);
        else { all.push(...entries); step(); }
      }, reject);
    }
    step();
  });
}
async function getAllFileEntries(dataTransferItemList){
  let queue = [];
  for (let i=0;i<dataTransferItemList.length;i++){
    const entry = dataTransferItemList[i].webkitGetAsEntry();
    if (entry) queue.push(entry);
  }
  let fileEntries = [];
  while (queue.length){
    const entry = queue.shift();
    if (entry.isFile) fileEntries.push(entry);
    else if (entry.isDirectory){
      const entries = await readAllEntries(entry.createReader());
      queue.push(...entries);
    }
  }
  return Promise.all(fileEntries.map(e => new Promise((res,rej) => e.file(res,rej))));
}

/* ============ EXIF extraction ============ */
async function handleFileList(files){
  const imageFiles = files.filter(f => /^image\//.test(f.type) || /\.(jpe?g|png|heic|tiff?)$/i.test(f.name));
  if (imageFiles.length === 0){ alert('선택한 폴더/파일에서 이미지를 찾지 못했습니다.'); return; }

  resetState();
  $('progress').style.display = 'block';
  $('progressText').textContent = `분석 중... 0 / ${imageFiles.length}`;

  const photos = [];
  let done = 0;
  const CONCURRENCY = 8;
  let idx = 0;
  async function worker(){
    while (idx < imageFiles.length){
      const i = idx++;
      const file = imageFiles[i];
      try {
        const out = await exifr.parse(file, { gps:true, tiff:true, exif:true, translateValues:true });
        const lat = out && (out.latitude ?? out.GPSLatitude);
        const lon = out && (out.longitude ?? out.GPSLongitude);
        const time = (out && (out.DateTimeOriginal || out.CreateDate || out.ModifyDate)) || new Date(file.lastModified);
        const w = (out && (out.ExifImageWidth || out.ImageWidth)) || 0;
        const h = (out && (out.ExifImageHeight || out.ImageHeight)) || 0;
        if (typeof lat === 'number' && typeof lon === 'number' && !isNaN(lat) && !isNaN(lon)){
          photos.push({
            file, name: file.webkitRelativePath || file.name,
            url: URL.createObjectURL(file),
            lat, lon, time: (time instanceof Date && !isNaN(time)) ? time : new Date(file.lastModified),
            w, h, size: file.size
          });
        }
      } catch(err) { /* skip unreadable file */ }
      done++;
      if (done % 5 === 0 || done === imageFiles.length){
        $('progressText').textContent = `분석 중... ${done} / ${imageFiles.length}`;
        $('progressBar').style.width = (done/imageFiles.length*100) + '%';
      }
    }
  }
  await Promise.all(Array.from({length:CONCURRENCY}, worker));

  $('progress').style.display = 'none';
  allPhotos = photos.sort((a,b) => a.time - b.time);

  $('statTotal').textContent = imageFiles.length;
  $('statGeo').textContent = allPhotos.length;
  $('stats').style.display = 'grid';
  $('tripTitleTab').style.display = 'flex';
  $('empty').style.display = allPhotos.length ? 'none' : 'block';
  if (allPhotos.length === 0){
    $('empty').textContent = 'GPS 정보가 있는 사진을 찾지 못했습니다. (스크린샷/다운로드된 이미지는 보통 GPS가 없습니다)';
    $('empty').style.display = 'block';
    return;
  }

  buildClusters(SCALE_PRESETS[travelScale]);
}

function resetState(){
  allPhotos.forEach(p => URL.revokeObjectURL(p.url));
  allPhotos = []; clusters = [];
  markers.forEach(m => m.remove()); markers = [];
  if (movingMarker) { movingMarker.remove(); movingMarker = null; }
  stopAnim(); animElapsed = 0;
  camZoom = null; camLon = null; camLat = null; camFollow = (OVERVIEW_MODE ? false : true);
  $('placelist').innerHTML = '';
  closeDetail();
  $('timeline').classList.remove('show');
  $('btnFitAll').classList.remove('show');
  if (map && map.getSource('route-full')) map.getSource('route-full').setData(emptyLine());
  if (map && map.getSource('route-progress')) map.getSource('route-progress').setData(emptyLine());
}

/* ============ Clustering ============ */
function haversine(lat1,lon1,lat2,lon2){
  const R = 6371000, toRad = d => d*Math.PI/180;
  const dLat = toRad(lat2-lat1), dLon = toRad(lon2-lon1);
  const a = Math.sin(dLat/2)**2 + Math.cos(toRad(lat1))*Math.cos(toRad(lat2))*Math.sin(dLon/2)**2;
  return 2*R*Math.asin(Math.sqrt(a));
}

function buildClusters(radiusM, opts){
  opts = opts || {};
  const fit = opts.fit !== false;
  if (activeCluster !== null) closeDetail();

  // preserve any user-set custom names across re-clustering (scale switch, photo
  // deletion), keyed by photo identity since photo objects stay stable across rebuilds
  const customNameByPhoto = new Map();
  clusters.forEach(c => { if (c.customName) c.photos.forEach(p => customNameByPhoto.set(p, c.customName)); });

  const raw = []; // {lat,lon,photos:[]} — lat/lon = running centroid during grouping only
  for (const p of allPhotos){
    let best = null, bestD = Infinity;
    for (const c of raw){
      const d = haversine(p.lat,p.lon,c.lat,c.lon);
      if (d < radiusM && d < bestD){ best = c; bestD = d; }
    }
    if (best){
      best.photos.push(p);
      best.lat = best.photos.reduce((s,x)=>s+x.lat,0)/best.photos.length;
      best.lon = best.photos.reduce((s,x)=>s+x.lon,0)/best.photos.length;
    } else {
      raw.push({ lat:p.lat, lon:p.lon, photos:[p] });
    }
  }
  raw.forEach(c => {
    c.photos.sort((a,b)=>a.time-b.time);
    // route / marker waypoint = chronologically first GPS photo (visit entry), not average
    c.lat = c.photos[0].lat;
    c.lon = c.photos[0].lon;
    c.startTime = c.photos[0].time;
    c.endTime = c.photos[c.photos.length-1].time;
    c.rep = c.photos.reduce((best,x) => (x.w*x.h > best.w*best.h || (x.w*x.h===best.w*best.h && x.size>best.size)) ? x : best, c.photos[0]);
    for (const p of c.photos){ if (customNameByPhoto.has(p)){ c.customName = customNameByPhoto.get(p); break; } }
  });
  clusters = raw.sort((a,b) => a.startTime - b.startTime);

  const dayMap = new Map();
  clusters.forEach(c => {
    const key = dateKey(c.startTime);
    if (!dayMap.has(key)) dayMap.set(key, dayMap.size + 1);
    c.day = dayMap.get(key);
  });

  $('statPlaces').textContent = clusters.length;
  const first = allPhotos[0].time, last = allPhotos[allPhotos.length-1].time;
  $('statRange').textContent = fmtDateShort(first) + ' ~ ' + fmtDateShort(last);

  renderPlaceList();
  renderMarkers();
  renderRoute();
  $('btnFitAll').classList.toggle('show', clusters.length > 0);
  if (fit){
    setupAnimation();
    camFollow = (OVERVIEW_MODE ? false : true);
    fitToClusters();
    if (isMobile()) closeSidebar();
  } else {
    // keep segment timing in sync without touching the camera / moving marker
    computeSegments();
  }
  geocodeClusters();
}

/* ============ Reverse geocoding (approximate place names) ============ */
const geocodeCache = new Map();
let geocodeChain = Promise.resolve();
let lastGeocodeFetchAt = 0;

function scheduleGeocode(task){
  geocodeChain = geocodeChain.then(() => task()).catch(() => {});
}

async function reverseGeocode(lat, lon){
  const key = lat.toFixed(3) + ',' + lon.toFixed(3);
  if (geocodeCache.has(key)) return geocodeCache.get(key);
  // only real network lookups need to be paced to Nominatim's ~1/sec limit; cache hits return immediately
  const wait = 1100 - (Date.now() - lastGeocodeFetchAt);
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  lastGeocodeFetchAt = Date.now();
  let label = '';
  try {
    const res = await fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lon}&zoom=12&accept-language=ko`);
    const data = await res.json();
    const a = data.address || {};
    const province = a.state || a.province || a.region || '';
    let level1, level2;
    if (province){
      // e.g. 경기도 성남시
      level1 = province;
      level2 = a.city || a.county || a.borough || a.city_district || a.suburb || a.town || a.village || '';
    } else {
      // metropolitan/special city acts as the top level, e.g. 서울특별시 강남구
      level1 = a.city || a.county || '';
      level2 = a.borough || a.city_district || a.suburb || a.town || a.village || '';
    }
    label = [level1, level2].filter(Boolean).join(' ');
    if (!label && data.display_name) label = data.display_name.split(',').slice(0,2).join(',').trim();
  } catch(e) { /* offline or blocked: leave blank, falls back to 장소 N */ }
  geocodeCache.set(key, label);
  return label;
}

function geocodeClusters(){
  clusters.forEach(c => {
    if (c.placeName !== undefined) return;
    scheduleGeocode(async () => {
      c.placeName = await reverseGeocode(c.lat, c.lon);
      const curIdx = clusters.indexOf(c);
      if (curIdx !== -1) updateClusterLabel(curIdx);
    });
  });
}

function updateClusterLabel(idx){
  const c = clusters[idx];
  if (!c) return;
  const chip = document.querySelector(`#placelist .chip[data-idx="${idx}"]`);
  if (chip){
    const nameEl = chip.querySelector('.chip-name');
    if (nameEl) nameEl.textContent = c.customName || c.placeName || `장소 ${idx + 1}`;
    chip.title = placeLabel(c);
  }
  if (activeCluster === idx){
    $('dpTitle').textContent = placeLabel(c);
  }
  if (idx === 0) refreshTripTitleUI();
}

const SCALE_PRESETS = { day: 150, city: 3000, country: 30000 };
let travelScale = 'day';
document.querySelectorAll('#scalePicker .scale-btn').forEach(btn => {
  btn.classList.toggle('active', btn.dataset.scale === travelScale);
  btn.addEventListener('click', () => {
    travelScale = btn.dataset.scale;
    document.querySelectorAll('#scalePicker .scale-btn').forEach(b => b.classList.toggle('active', b === btn));
    if (allPhotos.length) buildClusters(SCALE_PRESETS[travelScale]);
  });
});

/* ============ Moving marker icon + color ============ */
(function buildIconPicker(){
  const box = $('iconPicker');
  Object.keys(MARKER_ICON_PATHS).forEach(id => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'icon-btn' + (id === movingIconType ? ' active' : '');
    btn.dataset.icon = id;
    btn.title = MARKER_ICON_LABELS[id] || id;
    btn.innerHTML = iconSvgHtml(id, 20);
    btn.addEventListener('click', () => {
      movingIconType = id;
      document.querySelectorAll('#iconPicker .icon-btn').forEach(b => b.classList.toggle('active', b === btn));
      applyMarkerIcon();
    });
    box.appendChild(btn);
  });
})();

const COLOR_SWATCHES = [
  { hex:'#8b93a7', label:'그레이' },
  { hex:'#3ecf8e', label:'민트' },
  { hex:'#4d9fff', label:'블루' },
  { hex:'#ff6b6b', label:'코랄' },
  { hex:'#f59e0b', label:'앰버' },
  { hex:'#a78bfa', label:'바이올렛' },
  { hex:'#ec4899', label:'핑크' },
  { hex:'#14b8a6', label:'틸' }
];

function buildColorPicker(containerId, role, current){
  const box = $(containerId);
  box.innerHTML = '';
  COLOR_SWATCHES.forEach(s => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'color-btn' + (s.hex.toLowerCase() === current.toLowerCase() ? ' active' : '');
    btn.dataset.color = s.hex;
    btn.title = s.label;
    btn.style.background = s.hex;
    btn.addEventListener('click', () => setThemeColor(role, s.hex));
    box.appendChild(btn);
  });
  const custom = document.createElement('input');
  custom.type = 'color';
  custom.className = 'color-custom';
  custom.id = role === 'path' ? 'pathColorCustom' : 'progressColorCustom';
  custom.value = current;
  custom.title = '직접 선택';
  custom.addEventListener('input', e => setThemeColor(role, e.target.value));
  box.appendChild(custom);
}

function setThemeColor(role, hex){
  if (!hex) return;
  if (role === 'path') pathColor = hex;
  else progressColor = hex;
  document.documentElement.style.setProperty('--path', pathColor);
  document.documentElement.style.setProperty('--progress', progressColor);
  const box = $(role === 'path' ? 'pathColorPicker' : 'progressColorPicker');
  const custom = $(role === 'path' ? 'pathColorCustom' : 'progressColorCustom');
  if (custom) custom.value = role === 'path' ? pathColor : progressColor;
  box.querySelectorAll('.color-btn').forEach(b => {
    const cur = role === 'path' ? pathColor : progressColor;
    b.classList.toggle('active', b.dataset.color.toLowerCase() === cur.toLowerCase());
  });
  applyMarkerIcon();
  if (map){
    setupRouteLayers();
    if (clusters.length){
      renderRoute();
      if (animTotal > 0) renderFrame(animElapsed);
    }
  }
}

buildColorPicker('pathColorPicker', 'path', pathColor);
buildColorPicker('progressColorPicker', 'progress', progressColor);
setThemeColor('path', pathColor);
setThemeColor('progress', progressColor);

(function initArrivalModeOption(){
  const box = $('arrivalModePicker');
  if (!box) return;
  try {
    const saved = localStorage.getItem(LS_ARRIVAL_MODE);
    if (saved === 'move' || saved === 'popup') arrivalMode = saved;
    else {
      const legacy = localStorage.getItem(LS_PHOTO_FAN_LEGACY);
      if (legacy === '1') arrivalMode = 'popup';
      else if (legacy === '0') arrivalMode = 'move';
    }
  } catch (e) { /* ignore */ }
  const syncBtns = () => {
    box.querySelectorAll('.mode-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.mode === arrivalMode);
    });
  };
  syncBtns();
  box.querySelectorAll('.mode-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const mode = btn.dataset.mode;
      if (mode !== 'move' && mode !== 'popup') return;
      if (arrivalMode === mode) return;
      arrivalMode = mode;
      try { localStorage.setItem(LS_ARRIVAL_MODE, arrivalMode); } catch (e) { /* ignore */ }
      syncBtns();
      if (arrivalMode === 'move') hideSpotCard();
      if (clusters.length >= 2){
        const ratio = animTotal > 0 ? animElapsed / animTotal : 0;
        computeSegments();
        animElapsed = Math.min(animTotal, ratio * animTotal);
        if (animTotal > 0) renderFrame(animElapsed);
      }
    });
  });
})();

function applyMarkerIcon(){
  if (!movingMarker) return;
  const el = movingMarker.getElement();
  const keepBubble = arrivalBubbleLabel;
  el.className = 'moving-marker';
  const svg = iconSvgHtml(movingIconType, 18);
  el.innerHTML = '<span class="core"></span>' +
    (svg ? `<span class="icon-badge" data-icon="${movingIconType}">${svg}</span>` : '');
  syncMovingMarkerPlaying();
  if (keepBubble && arrivalMode === 'move') setArrivalBubble(keepBubble);
}

/* ============ Rendering: markers, list, route ============ */
function renderMarkers(){
  markers.forEach(m => m.remove());
  markers = clusters.map((c, i) => {
    const el = document.createElement('div');
    el.className = 'photo-marker';
    const pin = document.createElement('div');
    pin.className = 'pin';
    pin.style.backgroundImage = `url(${c.rep.url})`;
    if (c.photos.length > 1){
      const badge = document.createElement('div');
      badge.className = 'count'; badge.textContent = c.photos.length;
      pin.appendChild(badge);
    }
    el.appendChild(pin);
    el.addEventListener('click', () => selectCluster(i, true));
    const marker = new maplibregl.Marker({ element: el, anchor: 'center' })
      .setLngLat([c.lon, c.lat]).addTo(map);
    marker._el = el;
    return marker;
  });
}

function renderPlaceList(){
  const list = $('placelist');
  list.innerHTML = '';
  placeChips = [];
  let lastDay = null;
  let chipRow = null;
  clusters.forEach((c, i) => {
    if (c.day !== lastDay){
      lastDay = c.day;
      const dayNum = c.day;
      const dayRow = document.createElement('div');
      dayRow.className = 'day-row';

      const dayTag = document.createElement('div');
      dayTag.className = 'day-tag';
      const dayLabel = document.createElement('span');
      dayLabel.textContent = 'Day ' + dayNum;
      const dayDate = document.createElement('span');
      dayDate.className = 'day-date';
      dayDate.textContent = fmtDateShort(c.startTime);
      const dayDel = document.createElement('button');
      dayDel.type = 'button';
      dayDel.className = 'day-del';
      dayDel.title = `Day ${dayNum} 전체 삭제`;
      dayDel.textContent = '🗑️';
      dayDel.addEventListener('click', e => {
        e.stopPropagation();
        deleteDay(dayNum);
      });
      dayTag.appendChild(dayLabel);
      dayTag.appendChild(dayDate);
      dayTag.appendChild(dayDel);
      dayRow.appendChild(dayTag);

      chipRow = document.createElement('div');
      chipRow.className = 'chip-row';
      dayRow.appendChild(chipRow);
      list.appendChild(dayRow);
    } else {
      const arrow = document.createElement('span');
      arrow.className = 'chip-arrow';
      arrow.textContent = '›';
      chipRow.appendChild(arrow);
    }

    const chip = document.createElement('div');
    chip.className = 'chip';
    chip.dataset.idx = i;
    chip.title = placeLabel(c);

    const thumb = document.createElement('div');
    thumb.className = 'chip-thumb';
    thumb.style.backgroundImage = `url(${c.rep.url})`;
    if (c.photos.length > 1){
      const count = document.createElement('span');
      count.className = 'chip-count';
      count.textContent = String(c.photos.length);
      thumb.appendChild(count);
    }

    const name = document.createElement('span');
    name.className = 'chip-name';
    name.textContent = c.customName || c.placeName || `장소 ${i + 1}`;

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'chip-del';
    del.title = '이 장소 삭제';
    del.textContent = '✕';
    del.addEventListener('click', e => {
      e.stopPropagation();
      deleteCluster(i);
    });

    chip.appendChild(thumb);
    chip.appendChild(name);
    chip.appendChild(del);
    chip.addEventListener('click', () => selectCluster(i, true));
    chipRow.appendChild(chip);
    placeChips.push(chip);
  });
}
function placeLabel(c){
  const name = c.customName || c.placeName || `장소 ${clusters.indexOf(c)+1}`;
  return `${name} · 사진 ${c.photos.length}장`;
}
function dayPlaceLabel(c){ return `Day ${c.day} · ${placeLabel(c)}`; }

function renderRoute(){
  if (!map.getSource('route-full')) return;
  const coords = clusters.map(c => [c.lon, c.lat]);
  map.getSource('route-full').setData({ type:'Feature', geometry:{type:'LineString', coordinates: coords.length>1?coords:[]}, properties:{} });
}

function fitToClusters(){
  if (!clusters.length) return;
  if (OVERVIEW_MODE){ jumpToTripOverview(); return; }
  const padding = mapPadding();
  camFollow = (OVERVIEW_MODE ? false : true);
  if (clusters.length === 1){
    map.flyTo({ center:[clusters[0].lon, clusters[0].lat], zoom:13, padding, duration:450, essential:true });
    camZoom = 13;
    camLon = clusters[0].lon;
    camLat = clusters[0].lat;
    return;
  }
  const b = new maplibregl.LngLatBounds();
  clusters.forEach(c => b.extend([c.lon, c.lat]));
  map.fitBounds(b, { padding, maxZoom: CAM_MAX_ZOOM, duration:450, essential:true });
  try {
    const cam = map.cameraForBounds(b, { padding, maxZoom: CAM_MAX_ZOOM });
    if (cam){
      camZoom = cam.zoom;
      camLon = cam.center.lng;
      camLat = cam.center.lat;
    }
  } catch (e) { /* ignore */ }
}

/* ============ Detail panel ============ */
function selectCluster(i, fly){
  activeCluster = i;
  markers.forEach((m,idx) => m._el.classList.toggle('active', idx===i));
  placeChips.forEach((el, idx) => el.classList.toggle('active', idx===i));
  const c = clusters[i];
  if (fly && !OVERVIEW_MODE){
    camFollow = false;
    map.flyTo({ center:[c.lon,c.lat], zoom: Math.max(map.getZoom(),14), duration:400, essential:true });
  }

  $('dpTitle').textContent = placeLabel(c);
  $('dpSub').textContent = `Day ${c.day} · ${fmtDateTime(c.startTime)}${c.endTime>c.startTime ? ' ~ '+fmtDateTime(c.endTime) : ''} · 위도 ${c.lat.toFixed(5)}, 경도 ${c.lon.toFixed(5)}`;
  const grid = $('dpGrid'); grid.innerHTML = '';
  c.photos.forEach((p, pi) => {
    const div = document.createElement('div');
    div.className = 'ph' + (p===c.rep ? ' rep' : '');
    div.style.backgroundImage = `url(${p.url})`;
    div.title = p.name;
    div.addEventListener('click', () => openLightbox(c.photos, pi));
    const del = document.createElement('button');
    del.className = 'ph-del';
    del.type = 'button';
    del.title = '이 사진 삭제';
    del.textContent = '✕';
    del.addEventListener('click', e => {
      e.stopPropagation();
      if (confirm('이 사진을 삭제할까요?')) deletePhoto(p, c);
    });
    div.appendChild(del);
    grid.appendChild(div);
  });
  $('detailpanel').classList.add('show');
  if (isMobile()) closeSidebar();
}
function closeDetail(){
  $('detailpanel').classList.remove('show');
  activeCluster = null;
  markers.forEach(m => m._el.classList.remove('active'));
}
$('dpClose').addEventListener('click', closeDetail);
$('dpEdit').addEventListener('click', () => {
  if (activeCluster === null) return;
  const c = clusters[activeCluster];
  const current = c.customName || c.placeName || `장소 ${activeCluster+1}`;
  const val = prompt('장소 이름 바꾸기', current);
  if (val === null) return;
  c.customName = val.trim() || undefined;
  renderPlaceList();
  refreshTripTitleUI();
  selectCluster(activeCluster, false);
});
$('dpDel').addEventListener('click', () => {
  if (activeCluster === null) return;
  deleteCluster(activeCluster);
});

/* ============ Delete photos / places / days ============ */
function deletePhotos(photos, opts){
  opts = opts || {};
  if (!photos || !photos.length) return;
  pauseAnim();
  cancelPlayIntro();
  if (!opts.keepLightbox) $('lightbox').classList.remove('show');

  const removeSet = new Set(photos);
  const removedCount = photos.length;
  photos.forEach(p => { try { URL.revokeObjectURL(p.url); } catch (e) { /* ignore */ } });
  allPhotos = allPhotos.filter(p => !removeSet.has(p));

  $('statTotal').textContent = Math.max(0, Number($('statTotal').textContent) - removedCount);
  $('statGeo').textContent = allPhotos.length;

  if (allPhotos.length === 0){
    closeDetail();
    $('lightbox').classList.remove('show');
    resetState();
    $('stats').style.display = 'none';
    $('tripTitleTab').style.display = 'none';
    $('empty').innerHTML = '아직 불러온 사진이 없습니다.<br>왼쪽 위 버튼으로 폴더를 선택해 보세요.';
    $('empty').style.display = 'block';
    return;
  }

  $('empty').style.display = 'none';
  buildClusters(SCALE_PRESETS[travelScale], { fit:false });
  setupAnimation();

  if (opts.keepSibling){
    const idx = clusters.findIndex(c => c.photos.includes(opts.keepSibling));
    if (idx !== -1) selectCluster(idx, false);
    else closeDetail();
  } else {
    closeDetail();
  }
}

function deletePhoto(photo, cluster){
  const sibling = cluster && cluster.photos ? cluster.photos.find(p => p !== photo) : null;
  deletePhotos([photo], { keepSibling: sibling || null });
}

function deleteCluster(idx){
  const c = clusters[idx];
  if (!c) return;
  const n = c.photos.length;
  if (!confirm(`이 장소(사진 ${n}장)를 삭제할까요?`)) return;
  deletePhotos(c.photos.slice());
}

function deleteDay(dayNum){
  const dayClusters = clusters.filter(c => c.day === dayNum);
  if (!dayClusters.length) return;
  const n = dayClusters.reduce((s, c) => s + c.photos.length, 0);
  if (!confirm(`Day ${dayNum}의 장소·사진(${n}장)을 모두 삭제할까요?`)) return;
  const photos = [];
  dayClusters.forEach(c => c.photos.forEach(p => photos.push(p)));
  deletePhotos(photos);
}

/* ============ Lightbox ============ */
function openLightbox(photos, i){
  lightboxPhotos = photos; lightboxIndex = i;
  showLightboxImg();
  $('lightbox').classList.add('show');
}
function showLightboxImg(){
  const p = lightboxPhotos[lightboxIndex];
  $('lbImg').src = p.url;
  $('lbInfo').textContent = `${p.name} · ${fmtDateTime(p.time)}`;
}
$('lbDel').addEventListener('click', () => {
  const p = lightboxPhotos[lightboxIndex];
  if (!p || !confirm('이 사진을 삭제할까요?')) return;
  const sibling = lightboxPhotos.find(x => x !== p) || null;
  const keepLightbox = !!sibling;
  deletePhotos([p], { keepSibling: sibling, keepLightbox });
  if (!sibling){
    $('lightbox').classList.remove('show');
    return;
  }
  const newCluster = clusters.find(c => c.photos.includes(sibling));
  if (!newCluster){
    $('lightbox').classList.remove('show');
    return;
  }
  lightboxPhotos = newCluster.photos;
  const si = lightboxPhotos.indexOf(sibling);
  lightboxIndex = si >= 0 ? si : Math.min(lightboxIndex, lightboxPhotos.length - 1);
  showLightboxImg();
});
$('lbClose').addEventListener('click', () => $('lightbox').classList.remove('show'));
$('lightbox').addEventListener('click', e => { if (e.target.id==='lightbox') $('lightbox').classList.remove('show'); });
$('lbPrev').addEventListener('click', () => { lightboxIndex = (lightboxIndex-1+lightboxPhotos.length)%lightboxPhotos.length; showLightboxImg(); });
$('lbNext').addEventListener('click', () => { lightboxIndex = (lightboxIndex+1)%lightboxPhotos.length; showLightboxImg(); });
document.addEventListener('keydown', e => {
  if (!$('lightbox').classList.contains('show')) return;
  if (e.key==='Escape') $('lightbox').classList.remove('show');
  if (e.key==='ArrowLeft') $('lbPrev').click();
  if (e.key==='ArrowRight') $('lbNext').click();
});

/* ============ Animation (시네마틱 동선 재생) ============ */

function computeSegments(){
  if (clusters.length < 2){
    segDurations = []; segDwells = []; segKm = []; segLong = []; segNear = [];
    segHopZoom = []; segTight = []; segWindowZoom = []; segLocal = []; animTotal = 0;
    $('timeline').classList.remove('show');
    return false;
  }
  $('timeline').classList.add('show');
  computeTripBaseZoom();
  segDurations = [];
  segKm = [];
  segLong = [];
  segNear = [];
  segHopZoom = [];
  segTight = [];
  segWindowZoom = [];
  segLocal = [];
  segDwells = clusters.map(c => dwellMsForCluster(c));
  const hopCount = clusters.length - 1;
  for (let i = 0; i < hopCount; i++){
    const a = clusters[i], b = clusters[i + 1];
    const km = haversine(a.lat, a.lon, b.lat, b.lon) / 1000;
    const fitZ = hopFitCamera(a, b).zoom;
    const pts = [a, b];
    if (i + 2 < clusters.length) pts.push(clusters[i + 2]);
    const winZ = fitPointsZoom(pts);
    segKm.push(km);
    segNear.push(km < NEAR_HOP_KM);
    segLong.push(km >= LONG_HOP_KM);
    segHopZoom.push(fitZ);
    segTight.push(fitZ > baseZoom + TIGHT_HOP_DELTA);
    segWindowZoom.push(winZ);
    segDurations.push(hopDurationMs(km));
  }
  for (let i = 0; i < hopCount; i++){
    const local =
      segWindowZoom[i] > baseZoom + TIGHT_HOP_DELTA ||
      segTight[i] ||
      (i + 1 < hopCount && segTight[i + 1]);
    segLocal.push(!!local);
  }
  animTotal = segDwells.reduce((sum, d) => sum + d, 0) + segDurations.reduce((sum, d) => sum + d, 0);
  return true;
}

function setupAnimation(){
  stopAnim();
  animElapsed = 0;
  camZoom = null;
  camLon = null;
  camLat = null;
  arrivalBubbleLabel = null;
  lastCamPhaseKey = null;
  lastPopPinIdx = null;
  hideSpotCard();
  hideDayBanner();
  hideEndSummary();
  hideTopProgress();
  hideTripIntro();
  camFollow = false;
  cineMode = 'idle';
  if (map.getSource('route-progress')) map.getSource('route-progress').setData(emptyLine());
  if (!computeSegments()){
    if (movingMarker){ movingMarker.remove(); movingMarker = null; }
    return;
  }

  if (movingMarker) movingMarker.remove();
  const el = document.createElement('div');
  movingMarker = new maplibregl.Marker({ element: el, anchor: 'center' })
    .setLngLat([clusters[0].lon, clusters[0].lat]).addTo(map);
  applyMarkerIcon();

  $('tlNow').textContent = fmtDateShort(clusters[0].startTime);
  $('tlEnd').textContent = fmtDateShort(clusters[clusters.length-1].startTime);
  $('tlPlace').textContent = dayPlaceLabel(clusters[0]);
  $('tlRange').value = 0;
  refreshTripTitleUI();
  renderFrame(0);
}

function lerpAlongRoute(a, b, t){
  if (t <= 0) return { lon: a.lon, lat: a.lat };
  if (t >= 1) return { lon: b.lon, lat: b.lat };
  const aM = maplibregl.MercatorCoordinate.fromLngLat({ lng: a.lon, lat: a.lat });
  const bM = maplibregl.MercatorCoordinate.fromLngLat({ lng: b.lon, lat: b.lat });
  const m = new maplibregl.MercatorCoordinate(
    aM.x + (bM.x - aM.x) * t,
    aM.y + (bM.y - aM.y) * t,
    aM.z + (bM.z - aM.z) * t
  );
  const ll = m.toLngLat();
  return { lon: ll.lng, lat: ll.lat };
}

function easeCamToward(targetZoom, targetLon, targetLat, dtSec){
  if (camZoom == null) camZoom = map.getZoom();
  if (camLon == null){ camLon = targetLon; camLat = targetLat; }
  const dz = targetZoom - camZoom;
  if (Math.abs(dz) >= CAM_ZOOM_DEADBAND){
    const rate = dz < 0 ? CAM_ZOOM_OUT_RATE : CAM_ZOOM_IN_RATE;
    const maxDz = rate * dtSec;
    if (dz > maxDz) camZoom += maxDz;
    else if (dz < -maxDz) camZoom -= maxDz;
    else camZoom += dz * Math.min(1, 2.5 * dtSec);
  }
  const blend = Math.min(1, CAM_CENTER_BLEND * (dtSec * 60));
  camLon += (targetLon - camLon) * blend;
  camLat += (targetLat - camLat) * blend;
  const cur = map.getCenter();
  const zNow = map.getZoom();
  if (Math.abs(camZoom - zNow) > 0.01 || Math.abs(camLon - cur.lng) > 1e-7 || Math.abs(camLat - cur.lat) > 1e-7){
    map.jumpTo({ center: [camLon, camLat], zoom: camZoom });
  }
}

function renderFrame(elapsed, frameDt){
  elapsed = Math.max(0, Math.min(animTotal, elapsed));
  const dtSec = Math.max(0, Math.min(0.05, (frameDt || 16) / 1000));
  const phase = phaseAtElapsed(elapsed);
  const n = clusters.length;
  let lat, lon, nearIdx, reachedIdx, a, b, segT;

  if (phase.kind === 'dwell'){
    const c = clusters[phase.clusterIdx];
    lat = c.lat; lon = c.lon;
    nearIdx = phase.clusterIdx;
    reachedIdx = phase.clusterIdx;
    a = c;
    b = clusters[Math.min(phase.clusterIdx + 1, n - 1)] || c;
    segT = 1;
    popPinAt(phase.clusterIdx);
    if (phase.clusterIdx > 0 && clusters[phase.clusterIdx].day !== clusters[phase.clusterIdx - 1].day && phase.t < 0.55){
      const d = clusters[phase.clusterIdx];
      showDayBanner('DAY ' + d.day + ' · ' + fmtDateShort(d.startTime));
    } else if (phase.t > 0.7){
      hideDayBanner();
    }
    setArrivalBubble(null);
    if (isPlaying || isRecording || cineMode === 'main' || (cineMode === 'intro' && cineStage >= 2)){
      showTopProgress(c, phase.clusterIdx);
    } else {
      hideTopProgress();
    }
    if (arrivalMode === 'popup') showSpotCardPhoto(c, phase.clusterIdx, phase.t);
    else hideSpotCard();
  } else {
    const segIdx = phase.segIdx;
    a = clusters[segIdx];
    b = clusters[segIdx + 1] || a;
    const eased = easeTravel(phase.t);
    segT = eased;
    ({ lat, lon } = lerpAlongRoute(a, b, eased));
    nearIdx = eased < 0.5 ? segIdx : Math.min(segIdx + 1, n - 1);
    if (eased >= 0.8) nearIdx = Math.min(segIdx + 1, n - 1);
    reachedIdx = eased >= 0.98 ? Math.min(segIdx + 1, n - 1) : segIdx;
    setArrivalBubble(null);
    hideSpotCard();
    hideDayBanner();
    if (isPlaying || isRecording || cineMode === 'main' || (cineMode === 'intro' && cineStage >= 2)){
      showTopProgress(clusters[nearIdx], nearIdx);
    } else {
      hideTopProgress();
    }
  }

  if (movingMarker) movingMarker.setLngLat([lon, lat]);
  syncMovingMarkerPlaying();

  if (camFollow){
    let targetZoom = baseZoom;
    let from = a, to = b;
    let lead = 0;

    if (phase.kind === 'dwell'){
      const prevHop = phase.clusterIdx > 0 ? phase.clusterIdx - 1 : null;
      const nextHop = phase.clusterIdx < n - 1 ? phase.clusterIdx : null;
      const localZs = [];
      if (prevHop != null && segLocal[prevHop]) localZs.push(segWindowZoom[prevHop]);
      if (nextHop != null && segLocal[nextHop]) localZs.push(segWindowZoom[nextHop]);
      if (localZs.length){
        targetZoom = Math.max(baseZoom, Math.min(CAM_MAX_ZOOM, Math.min.apply(null, localZs)));
      } else {
        const near = prevHop != null ? segNear[prevHop] : (segNear[0] || false);
        targetZoom = near ? baseZoom : arrivalZoom;
      }
      lead = 0;
    } else {
      const segIdx = phase.segIdx;
      const long = segLong[segIdx];
      const local = segLocal[segIdx];
      lead = 1;
      if (local){
        targetZoom = Math.max(baseZoom, Math.min(CAM_MAX_ZOOM, segWindowZoom[segIdx]));
        if (segT >= 0.8) lead = Math.max(0, 1 - (segT - 0.8) / 0.2);
      } else if (segT >= 0.8){
        targetZoom = arrivalZoom;
        lead = Math.max(0, 1 - (segT - 0.8) / 0.2);
      } else if (long && segT > 0.3 && segT < 0.55){
        targetZoom = Math.max(CAM_MIN_ZOOM, baseZoom - LONG_HOP_OUT);
      } else {
        targetZoom = baseZoom;
      }
    }

    const leadPt = leadRoomCenter(lon, lat, from, to, lead);
    easeCamToward(targetZoom, leadPt.lon, leadPt.lat, dtSec);
  }

  const traveled = [];
  if (phase.kind === 'dwell'){
    for (let i = 0; i <= phase.clusterIdx; i++) traveled.push([clusters[i].lon, clusters[i].lat]);
  } else {
    for (let i = 0; i <= phase.segIdx; i++) traveled.push([clusters[i].lon, clusters[i].lat]);
    traveled.push([lon, lat]);
  }
  if (map.getSource('route-progress')) {
    map.getSource('route-progress').setData({ type:'Feature', geometry:{type:'LineString',coordinates:traveled}, properties:{} });
  }

  markers.forEach((m, idx) => {
    m._el.classList.toggle('active', idx === nearIdx);
    m._el.classList.toggle('visited', idx <= reachedIdx);
  });
  placeChips.forEach((el, idx) => {
    el.classList.toggle('active', idx === nearIdx);
    el.classList.toggle('visited', idx <= reachedIdx);
  });
  $('tlPlace').textContent = dayPlaceLabel(clusters[nearIdx]);
  if (phase.kind === 'dwell'){
    $('tlNow').textContent = fmtDateShort(clusters[phase.clusterIdx].startTime);
  } else {
    $('tlNow').textContent = fmtDateShort(new Date(a.startTime.getTime() + (b.startTime - a.startTime) * segT));
  }
  $('tlRange').value = animTotal > 0 ? Math.round(elapsed / animTotal * 1000) : 0;
}

function renderIntroFrame(dtSec){
  const c0 = clusters[0];
  if (movingMarker) movingMarker.setLngLat([c0.lon, c0.lat]);
  if (cineStage === 0){
    camLon = overviewLon; camLat = overviewLat; camZoom = overviewZoom;
    if (!OVERVIEW_MODE) map.jumpTo({ center: [camLon, camLat], zoom: camZoom });
    showTripIntro();
    hideTopProgress();
    hideSpotCard();
  } else if (cineStage === 1){
    hideTripIntro();
    hideTopProgress();
    const t = Math.min(1, cineElapsed / INTRO_ZOOM_MS);
    const e = easeTravel(t);
    camLon = overviewLon + (c0.lon - overviewLon) * e;
    camLat = overviewLat + (c0.lat - overviewLat) * e;
    camZoom = overviewZoom + (arrivalZoom - overviewZoom) * e;
    if (!OVERVIEW_MODE) map.jumpTo({ center: [camLon, camLat], zoom: camZoom });
  } else {
    hideTripIntro();
    camLon = c0.lon; camLat = c0.lat; camZoom = arrivalZoom;
    if (!OVERVIEW_MODE) map.jumpTo({ center: [camLon, camLat], zoom: camZoom });
    showTopProgress(c0, 0);
    if (arrivalMode === 'popup') showSpotCardPhoto(c0, 0, 0);
    else hideSpotCard();
    popPinAt(0);
  }
}

function renderOutroFrame(){
  if (cineStage === 0) return;
  const t = Math.min(1, cineElapsed / OUTRO_ZOOM_MS);
  const e = easeTravel(t);
  const startZ = outroStartZoom != null ? outroStartZoom : arrivalZoom;
  const startLon = outroStartLon != null ? outroStartLon : clusters[clusters.length - 1].lon;
  const startLat = outroStartLat != null ? outroStartLat : clusters[clusters.length - 1].lat;
  camLon = startLon + (overviewLon - startLon) * e;
  camLat = startLat + (overviewLat - startLat) * e;
  camZoom = startZ + (overviewZoom - startZ) * e;
  if (!OVERVIEW_MODE) map.jumpTo({ center: [camLon, camLat], zoom: camZoom });
  if (t > 0.55) showEndSummary();
}

let outroStartZoom = null, outroStartLon = null, outroStartLat = null;

function startCineIntro(){
  computeTripBaseZoom();
  jumpToTripOverview();
  camFollow = false;
  cineMode = 'intro';
  cineStage = 0;
  cineElapsed = 0;
  hideEndSummary();
  hideSpotCard();
  hideDayBanner();
  hideTopProgress();
  showTripIntro();
  if (movingMarker) movingMarker.setLngLat([clusters[0].lon, clusters[0].lat]);
}

function startCineOutro(){
  hideSpotCard();
  hideDayBanner();
  hideTopProgress();
  hideTripIntro();
  setArrivalBubble(null);
  camFollow = false;
  cineMode = 'outro';
  cineStage = 0;
  cineElapsed = 0;
  outroStartZoom = map.getZoom();
  outroStartLon = map.getCenter().lng;
  outroStartLat = map.getCenter().lat;
  captureOverviewCamera();
}

function tickPlayback(dtMs){
  const dtSec = Math.max(0, Math.min(0.05, dtMs / 1000));
  if (cineMode === 'intro'){
    cineElapsed += dtMs;
    if (cineStage === 0){
      renderIntroFrame(dtSec);
      if (cineElapsed >= INTRO_OVERVIEW_MS){ cineStage = 1; cineElapsed = 0; }
    } else if (cineStage === 1){
      renderIntroFrame(dtSec);
      if (cineElapsed >= INTRO_ZOOM_MS){ cineStage = 2; cineElapsed = 0; }
    } else {
      renderIntroFrame(dtSec);
      if (cineElapsed >= INTRO_HOLD_MS){
        cineMode = 'main';
        cineElapsed = 0;
        animElapsed = 0;
        camFollow = (OVERVIEW_MODE ? false : true);
        lastPopPinIdx = null;
        renderFrame(0, dtMs);
      }
    }
    return false;
  }
  if (cineMode === 'outro'){
    cineElapsed += dtMs;
    if (cineStage === 0){
      if (cineElapsed >= OUTRO_HOLD_MS){ cineStage = 1; cineElapsed = 0; }
    } else {
      renderOutroFrame();
      if (cineElapsed >= OUTRO_ZOOM_MS){
        cineMode = 'idle';
        showEndSummary();
        return true; // finished
      }
    }
    return false;
  }
  // main
  animElapsed = Math.min(animTotal, animElapsed + dtMs);
  renderFrame(animElapsed, dtMs);
  if (animElapsed >= animTotal){
    startCineOutro();
  }
  return false;
}

function stepAnim(ts){
  if (!isPlaying) return;
  if (lastFrameTs == null) lastFrameTs = ts;
  const rawDt = ts - lastFrameTs;
  const speed = Number($('tlSpeed').value) || 1;
  const dt = rawDt * speed;
  lastFrameTs = ts;
  const done = tickPlayback(dt);
  if (done){
    pauseAnim();
    return;
  }
  if (cineMode === 'idle' && !isPlaying) return;
  rafId = requestAnimationFrame(stepAnim);
}

function cancelPlayIntro(){
  if (playIntroTimer != null){
    clearTimeout(playIntroTimer);
    playIntroTimer = null;
  }
}

function setTimelineCompact(on){
  const tl = $('timeline');
  if (!tl) return;
  tl.classList.toggle('is-compact', !!on);
}

function playAnim(){
  if (clusters.length < 2 || isRecording) return;
  cancelPlayIntro();
  hideEndSummary();
  setTimelineCompact(true);

  if (cineMode === 'intro' || cineMode === 'outro'){
    isPlaying = true;
    lastFrameTs = null;
    syncMovingMarkerPlaying();
    $('btnPlay').textContent = '⏸';
    rafId = requestAnimationFrame(stepAnim);
    return;
  }

  if (animElapsed >= animTotal) animElapsed = 0;

  if (animElapsed === 0){
    startCineIntro();
    isPlaying = true;
    lastFrameTs = null;
    syncMovingMarkerPlaying();
    $('btnPlay').textContent = '⏸';
    rafId = requestAnimationFrame(stepAnim);
    return;
  }

  cineMode = 'main';
  camFollow = (OVERVIEW_MODE ? false : true);
  isPlaying = true;
  lastFrameTs = null;
  syncMovingMarkerPlaying();
  $('btnPlay').textContent = '⏸';
  rafId = requestAnimationFrame(stepAnim);
}

function pauseAnim(){
  cancelPlayIntro();
  isPlaying = false;
  if (rafId) cancelAnimationFrame(rafId);
  rafId = null;
  syncMovingMarkerPlaying();
  if (!isRecording) setTimelineCompact(false);
  const playBtn = $('btnPlay');
  if (playBtn) playBtn.textContent = '▶ 미리보기';
}

function stopAnim(){
  pauseAnim();
  animElapsed = 0;
  cineMode = 'idle';
  setArrivalBubble(null);
  hideSpotCard();
  hideDayBanner();
  hideEndSummary();
  hideTopProgress();
  hideTripIntro();
  lastCamPhaseKey = null;
  lastPopPinIdx = null;
  setTimelineCompact(false);
}

function pickRecorderMime(){
  if (typeof MediaRecorder === 'undefined') return null;
  const mp4Types = [
    'video/mp4;codecs=avc1.42E01E',
    'video/mp4;codecs=avc1.4D001E',
    'video/mp4;codecs=avc1',
    'video/mp4'
  ];
  for (const t of mp4Types){
    if (MediaRecorder.isTypeSupported(t)) return { mime: t, kind: 'mp4' };
  }
  const webmTypes = [
    'video/webm;codecs=vp9',
    'video/webm;codecs=vp8',
    'video/webm'
  ];
  for (const t of webmTypes){
    if (MediaRecorder.isTypeSupported(t)) return { mime: t, kind: 'webm' };
  }
  return null;
}

let ffmpegBundle = null;
async function ensureFFmpeg(onProgress){
  if (ffmpegBundle) return ffmpegBundle;
  const [{ FFmpeg }, { toBlobURL, fetchFile }] = await Promise.all([
    import('https://cdn.jsdelivr.net/npm/@ffmpeg/ffmpeg@0.12.10/+esm'),
    import('https://cdn.jsdelivr.net/npm/@ffmpeg/util@0.12.1/+esm')
  ]);
  const ffmpeg = new FFmpeg();
  if (onProgress){
    ffmpeg.on('progress', ({ progress }) => {
      onProgress(Math.max(0, Math.min(100, Math.round((progress || 0) * 100))));
    });
  }
  const base = 'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.6/dist/esm';
  await ffmpeg.load({
    coreURL: await toBlobURL(base + '/ffmpeg-core.js', 'text/javascript'),
    wasmURL: await toBlobURL(base + '/ffmpeg-core.wasm', 'application/wasm')
  });
  ffmpegBundle = { ffmpeg, fetchFile };
  return ffmpegBundle;
}

function loadImage(url){
  return new Promise(resolve => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

/**
 * Approximates the .icon-badge[data-icon] CSS @keyframes (style.css mm-fly/mm-hop/etc)
 * for the canvas export path, which draws a static icon image instead of an animated
 * DOM element. Runs on wall-clock time like the CSS animations do (unaffected by the
 * timeline speed multiplier).
 */
function exportIconWiggle(iconType, tMs){
  const tri = period => { const f = (tMs % period) / period; return f < 0.5 ? f / 0.5 : 1 - (f - 0.5) / 0.5; };
  const lerp = (a, b, f) => a + (b - a) * f;
  switch (iconType){
    case 'airplane': { const f = tri(1100); return { dx: lerp(0, 3, f), dy: lerp(0, -4, f), rot: lerp(-8, 8, f), scale: 1 }; }
    case 'heart': return { dx: 0, dy: 0, rot: 0, scale: lerp(1, 1.14, tri(700)) };
    case 'moon': return { dx: 0, dy: 0, rot: lerp(-12, 12, tri(1600)), scale: 1 };
    case 'chess-king': return { dx: 0, dy: 0, rot: lerp(-12, 12, tri(1800)), scale: 1 };
    case 'rabbit': {
      const period = 550, f = (tMs % period) / period;
      const dy = f < 0.4 ? lerp(0, -6, f / 0.4) : f < 0.6 ? lerp(-6, -2, (f - 0.4) / 0.2) : lerp(-2, 0, (f - 0.6) / 0.4);
      return { dx: 0, dy, rot: 0, scale: 1 };
    }
    case 'ship': { const f = tri(1400); return { dx: 0, dy: lerp(0, 2, f), rot: lerp(-6, 6, f), scale: 1 }; }
    case 'truck': { const a = tMs / 450 * Math.PI * 2; return { dx: Math.sin(a), dy: -Math.sin(a), rot: 0, scale: 1 }; }
    case 'smile': return { dx: 0, dy: lerp(0, -3, tri(1000)), rot: 0, scale: 1 };
    case 'users': return { dx: 0, dy: lerp(0, -3, tri(1100)), rot: 0, scale: 1 };
    default: return { dx: 0, dy: 0, rot: 0, scale: 1 };
  }
}

/**
 * iOS fallback recording path: redraw the map canvas + pins + overlay cards onto an
 * offscreen canvas every frame (used with canvas.captureStream, see recordViaCanvas).
 * iOS has no getDisplayMedia/CropTarget, so there is no way to record the real DOM there.
 */
function drawExportFrame(ctx, outW, outH, markerImgs, exportIconImg, visitedSet, slideImgMap, nowMs){
  visitedSet = visitedSet || new Set();
  slideImgMap = slideImgMap || null;
  const mapCanvas = map.getCanvas();
  ctx.drawImage(mapCanvas, 0, 0, outW, outH);
  const sx = outW / mapCanvas.clientWidth;
  const sy = outH / mapCanvas.clientHeight;

  clusters.forEach((c, i) => {
    const p = map.project([c.lon, c.lat]);
    const x = p.x * sx, y = p.y * sy;
    const r = 20 * Math.min(sx, sy);
    if (x < -r || y < -r || x > outW + r || y > outH + r) return;
    ctx.save();
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.closePath();
    ctx.clip();
    if (markerImgs[i]) ctx.drawImage(markerImgs[i], x - r, y - r, r * 2, r * 2);
    else { ctx.fillStyle = '#4d9fff'; ctx.fillRect(x - r, y - r, r * 2, r * 2); }
    ctx.restore();
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.strokeStyle = visitedSet.has(i) ? progressColor : pathColor;
    ctx.lineWidth = 3 * Math.min(sx, sy);
    ctx.stroke();
    if (c.photos.length > 1){
      const br = 9 * Math.min(sx, sy);
      ctx.beginPath();
      ctx.arc(x + r * 0.7, y + r * 0.7, br, 0, Math.PI * 2);
      ctx.fillStyle = visitedSet.has(i) ? progressColor : pathColor;
      ctx.fill();
      ctx.fillStyle = visitedSet.has(i) ? '#08131f' : '#fff';
      ctx.font = `bold ${11 * Math.min(sx, sy)}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(c.photos.length), x + r * 0.7, y + r * 0.7);
    }
  });

  if (movingMarker){
    const ll = movingMarker.getLngLat();
    const p = map.project([ll.lng, ll.lat]);
    const x = p.x * sx, y = p.y * sy;
    const core = 7 * Math.min(sx, sy);
    const s = Math.min(sx, sy);

    ctx.beginPath();
    ctx.arc(x, y, core, 0, Math.PI * 2);
    ctx.fillStyle = progressColor;
    ctx.fill();
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 2 * Math.min(sx, sy);
    ctx.stroke();
    if (exportIconImg){
      const iw = 20 * Math.min(sx, sy);
      const wig = exportIconWiggle(movingIconType, nowMs || 0);
      const icx = x + wig.dx * s;
      const icy = y - core - iw - 2 * sy + wig.dy * s;
      ctx.save();
      ctx.translate(icx + iw / 2, icy + iw / 2);
      ctx.rotate(wig.rot * Math.PI / 180);
      ctx.scale(wig.scale, wig.scale);
      ctx.drawImage(exportIconImg, -iw / 2, -iw / 2, iw, iw);
      ctx.restore();
    }
    if (arrivalBubbleLabel && arrivalMode === 'move' && !spotCardState){
      const fontPx = Math.max(11, 12 * s);
      ctx.font = `600 ${fontPx}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const padX = 10 * s, padY = 6 * s;
      const textW = ctx.measureText(arrivalBubbleLabel).width;
      const bw = Math.min(200 * s, textW + padX * 2);
      const bh = fontPx + padY * 2;
      const bx = x - bw / 2;
      const by = y - core - (exportIconImg ? 24 * s : 8 * s) - bh - 8 * s;
      const r = 8 * s;
      ctx.beginPath();
      ctx.moveTo(bx + r, by);
      ctx.arcTo(bx + bw, by, bx + bw, by + bh, r);
      ctx.arcTo(bx + bw, by + bh, bx, by + bh, r);
      ctx.arcTo(bx, by + bh, bx, by, r);
      ctx.arcTo(bx, by, bx + bw, by, r);
      ctx.closePath();
      ctx.fillStyle = 'rgba(18,21,28,0.88)';
      ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,0.18)';
      ctx.lineWidth = 1 * s;
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(x - 6 * s, by + bh);
      ctx.lineTo(x, by + bh + 6 * s);
      ctx.lineTo(x + 6 * s, by + bh);
      ctx.closePath();
      ctx.fillStyle = 'rgba(18,21,28,0.88)';
      ctx.fill();
      ctx.fillStyle = '#e8eaef';
      ctx.fillText(arrivalBubbleLabel, x, by + bh / 2, bw - padX * 2);
    }
  }

  // Unified overlays: top progress bar (dark pill + pin badge, matches #topProgress CSS) + bottom photo (popup only)
  if (topProgressState && !tripIntroVisible){
    const s = Math.min(sx, sy);
    const badgeD = 28 * s;
    const padY = 8 * s, padL = 8 * s, padR = 16 * s, gap = 10 * s;
    const name = topProgressState.name || '';
    ctx.font = `600 ${Math.max(13, 15 * s)}px sans-serif`;
    const nameW = ctx.measureText(name).width;
    ctx.font = `700 ${Math.max(10, 10.5 * s)}px sans-serif`;
    const orderW = ctx.measureText(topProgressState.order).width;
    const textW = Math.max(orderW, nameW);
    const cardH = Math.max(badgeD + padY * 2, 44 * s);
    const cardW = Math.min(padL + badgeD + gap + textW + padR, outW * 0.78);
    const bx = (outW - cardW) / 2;
    const by = 12 * sy;
    const rr = cardH / 2;
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(bx + rr, by);
    ctx.arcTo(bx + cardW, by, bx + cardW, by + cardH, rr);
    ctx.arcTo(bx + cardW, by + cardH, bx, by + cardH, rr);
    ctx.arcTo(bx, by + cardH, bx, by, rr);
    ctx.arcTo(bx, by, bx + cardW, by, rr);
    ctx.closePath();
    ctx.fillStyle = 'rgba(26,30,41,0.92)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.09)';
    ctx.lineWidth = Math.max(1, s);
    ctx.stroke();

    const badgeCx = bx + padL + badgeD / 2;
    const badgeCy = by + cardH / 2;
    ctx.beginPath();
    ctx.arc(badgeCx, badgeCy, badgeD / 2, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(77,159,255,0.22)';
    ctx.fill();
    ctx.font = `${Math.max(12, 14 * s)}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('📍', badgeCx, badgeCy + 0.5 * s);

    const textX = bx + padL + badgeD + gap;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillStyle = '#4d9fff';
    ctx.font = `700 ${Math.max(10, 10.5 * s)}px sans-serif`;
    ctx.fillText(topProgressState.order, textX, by + cardH / 2 - 13 * s, cardW - (textX - bx) - padR);
    ctx.fillStyle = '#e8ebf3';
    ctx.font = `600 ${Math.max(13, 15 * s)}px sans-serif`;
    ctx.fillText(name, textX, by + cardH / 2 - 1 * s, cardW - (textX - bx) - padR);
    ctx.restore();
  }

  if (tripIntroVisible){
    const s = Math.min(sx, sy);
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.fillRect(0, 0, outW, outH);
    const cardW = Math.min(340 * s, outW * 0.88);
    const cardH = 120 * s;
    const bx = (outW - cardW) / 2;
    const by = (outH - cardH) / 2;
    const rr = 16 * s;
    ctx.beginPath();
    ctx.moveTo(bx + rr, by);
    ctx.arcTo(bx + cardW, by, bx + cardW, by + cardH, rr);
    ctx.arcTo(bx + cardW, by + cardH, bx, by + cardH, rr);
    ctx.arcTo(bx, by + cardH, bx, by, rr);
    ctx.arcTo(bx, by, bx + cardW, by, rr);
    ctx.closePath();
    ctx.fillStyle = 'rgba(255,255,255,0.95)';
    ctx.fill();
    const stay = tripStayLabel();
    ctx.fillStyle = '#1a1a1a';
    ctx.font = `700 ${Math.max(18, 22 * s)}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(getTripTitle(), outW / 2, by + 38 * s, cardW - 28 * s);
    ctx.fillStyle = '#5a6b5e';
    ctx.font = `700 ${Math.max(12, 14 * s)}px sans-serif`;
    ctx.fillText(stay.n > 1 ? stay.ko + ' · ' + stay.en : stay.en, outW / 2, by + 68 * s);
    ctx.fillStyle = '#667085';
    ctx.font = `${Math.max(11, 12 * s)}px sans-serif`;
    ctx.fillText(tripDateRangeLabel(), outW / 2, by + 92 * s);
  }

  // Bottom photo only (popup mode)
  if (spotCardState && spotCardState.photoUrl){
    const s = Math.min(sx, sy);
    const cardW = Math.min(280 * s, outW * 0.55);
    const pad = 10 * s;
    const photoH = Math.min(cardW * 0.72, 150 * s);
    const slideCountH = 18 * s;
    const cardH = pad + photoH + slideCountH + pad;
    const bx = (outW - cardW) / 2;
    const by = outH - 56 * sy - cardH;
    const rr = 14 * s;
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(bx + rr, by);
    ctx.arcTo(bx + cardW, by, bx + cardW, by + cardH, rr);
    ctx.arcTo(bx + cardW, by + cardH, bx, by + cardH, rr);
    ctx.arcTo(bx, by + cardH, bx, by, rr);
    ctx.arcTo(bx, by, bx + cardW, by, rr);
    ctx.closePath();
    ctx.fillStyle = 'rgba(255,255,255,0.94)';
    ctx.fill();
    const px = bx + pad;
    const py = by + pad;
    const pw = cardW - pad * 2;
    const ph = photoH;
    const pr = 10 * s;
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(px + pr, py);
    ctx.arcTo(px + pw, py, px + pw, py + ph, pr);
    ctx.arcTo(px + pw, py + ph, px, py + ph, pr);
    ctx.arcTo(px, py + ph, px, py, pr);
    ctx.arcTo(px, py, px + pw, py, pr);
    ctx.closePath();
    ctx.clip();
    const img = slideImgMap && slideImgMap.get(spotCardState.photoUrl);
    if (img) ctx.drawImage(img, px, py, pw, ph);
    else { ctx.fillStyle = '#e8ebe9'; ctx.fillRect(px, py, pw, ph); }
    ctx.restore();
    if (spotCardState.slideTotal != null){
      ctx.fillStyle = '#667085';
      ctx.font = `${Math.max(10, 11 * s)}px sans-serif`;
      ctx.textAlign = 'right';
      ctx.textBaseline = 'top';
      ctx.fillText(
        (spotCardState.slideIndex + 1) + ' / ' + spotCardState.slideTotal,
        bx + cardW - pad,
        py + ph + 4 * s
      );
    }
    ctx.restore();
  }

  if (dayBannerText){
    const s = Math.min(sx, sy);
    const fontPx = Math.max(12, 13 * s);
    ctx.font = `600 ${fontPx}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const tw = ctx.measureText(dayBannerText).width;
    const bw = tw + 28 * s, bh = fontPx + 16 * s;
    const bx = (outW - bw) / 2, by = 64 * sy;
    const rr = bh / 2;
    ctx.beginPath();
    ctx.moveTo(bx + rr, by);
    ctx.arcTo(bx + bw, by, bx + bw, by + bh, rr);
    ctx.arcTo(bx + bw, by + bh, bx, by + bh, rr);
    ctx.arcTo(bx, by + bh, bx, by, rr);
    ctx.arcTo(bx, by, bx + bw, by, rr);
    ctx.closePath();
    ctx.fillStyle = 'rgba(18,21,28,0.88)';
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.fillText(dayBannerText, outW / 2, by + bh / 2);
  }

  const endEl = $('endSummary');
  if (endEl && endEl.classList.contains('show')){
    const s = Math.min(sx, sy);
    const cardW = Math.min(420 * s, outW * 0.88);
    const cardH = 110 * s;
    const bx = (outW - cardW) / 2;
    const by = outH - 120 * sy - cardH;
    const rr = 16 * s;
    ctx.fillStyle = 'rgba(0,0,0,0.25)';
    ctx.fillRect(0, outH * 0.45, outW, outH * 0.55);
    ctx.beginPath();
    ctx.moveTo(bx + rr, by);
    ctx.arcTo(bx + cardW, by, bx + cardW, by + cardH, rr);
    ctx.arcTo(bx + cardW, by + cardH, bx, by + cardH, rr);
    ctx.arcTo(bx, by + cardH, bx, by, rr);
    ctx.arcTo(bx, by, bx + cardW, by, rr);
    ctx.closePath();
    ctx.fillStyle = 'rgba(255,255,255,0.95)';
    ctx.fill();
    const cols = [
      [$('esSpots').textContent, 'SPOTS'],
      [$('esPhotos').textContent, 'PHOTOS'],
      [$('esDays').textContent, 'DAYS'],
      [$('esKm').textContent, 'KM']
    ];
    const colW = cardW / 4;
    cols.forEach((c, i) => {
      const cx = bx + colW * (i + 0.5);
      ctx.fillStyle = '#1a1a1a';
      ctx.font = `700 ${Math.max(14, 18 * s)}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(c[0], cx, by + 32 * s);
      ctx.fillStyle = '#667085';
      ctx.font = `${Math.max(9, 10 * s)}px sans-serif`;
      ctx.fillText(c[1], cx, by + 52 * s);
    });
    ctx.fillStyle = '#667085';
    ctx.font = `${Math.max(10, 11 * s)}px sans-serif`;
    ctx.fillText('사진 촬영 위치 간 직선거리 기준', outW / 2, by + cardH - 18 * s);
  }
}

/** Always produce a playable video/mp4 Blob (re-encode when needed). */
async function toMp4Blob(inputBlob, onProgress){
  if (inputBlob.type.includes('mp4')){
    return new Blob([inputBlob], { type: 'video/mp4' });
  }
  const { ffmpeg, fetchFile } = await ensureFFmpeg(onProgress);
  const inName = 'input.webm';
  await ffmpeg.writeFile(inName, await fetchFile(inputBlob));
  // even dimensions required for yuv420p / H.264
  await ffmpeg.exec([
    '-i', inName,
    '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2',
    '-c:v', 'libx264',
    '-pix_fmt', 'yuv420p',
    '-preset', 'ultrafast',
    '-crf', '23',
    '-movflags', '+faststart',
    '-an',
    'output.mp4'
  ]);
  const data = await ffmpeg.readFile('output.mp4');
  try { await ffmpeg.deleteFile(inName); } catch (e) { /* ignore */ }
  try { await ffmpeg.deleteFile('output.mp4'); } catch (e) { /* ignore */ }
  return new Blob([data.buffer], { type: 'video/mp4' });
}

function waitMapFrame(){
  return new Promise(resolve => {
    map.once('render', () => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    map.triggerRepaint();
  });
}

function downloadBlob(blob, filename){
  const a = document.createElement('a');
  const url = URL.createObjectURL(blob);
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 8000);
}

/**
 * iOS Safari's <a download> often just opens the video inline instead of saving it.
 * Prefer the share sheet (Files/Photos) there; fall back to the anchor-click download
 * everywhere else (unchanged desktop behavior).
 */
async function saveVideoBlob(blob, filename){
  try {
    const file = new File([blob], filename, { type: 'video/mp4' });
    if (navigator.canShare && navigator.canShare({ files: [file] })){
      await navigator.share({ files: [file], title: filename });
      return;
    }
  } catch (e) { /* cancelled or unsupported — fall back below */ }
  downloadBlob(blob, filename);
}

function setRecordStatus(text){
  const el = $('recordStatus');
  if (!el) return;
  if (!text){
    el.classList.remove('show');
    el.textContent = '';
    return;
  }
  el.textContent = text;
  el.classList.add('show');
}

function jumpToTripOverview(){
  const padding = mapPadding();
  if (clusters.length === 1){
    map.jumpTo({ center:[clusters[0].lon, clusters[0].lat], zoom:13 });
    camZoom = 13; camLon = clusters[0].lon; camLat = clusters[0].lat;
    overviewZoom = 13; overviewLon = clusters[0].lon; overviewLat = clusters[0].lat;
    return;
  }
  const b = new maplibregl.LngLatBounds();
  clusters.forEach(c => b.extend([c.lon, c.lat]));
  try {
    const cam = map.cameraForBounds(b, { padding, maxZoom: CAM_MAX_ZOOM });
    if (cam){
      map.jumpTo({ center: cam.center, zoom: cam.zoom });
      camZoom = cam.zoom;
      camLon = cam.center.lng;
      camLat = cam.center.lat;
      overviewZoom = cam.zoom;
      overviewLon = cam.center.lng;
      overviewLat = cam.center.lat;
    }
  } catch (e) {
    map.fitBounds(b, { padding, maxZoom: CAM_MAX_ZOOM, duration: 0 });
  }
}

async function recordAndDownload(){
  if (isRecording || clusters.length < 2) return;
  if (typeof MediaRecorder === 'undefined'){
    alert('이 브라우저는 동영상 저장을 지원하지 않습니다. Chrome, Edge, 또는 Safari를 사용해 주세요.');
    return;
  }
  const picked = pickRecorderMime();
  if (!picked){
    alert('이 브라우저는 동영상 인코딩을 지원하지 않습니다. Chrome, Edge, 또는 Safari를 사용해 주세요.');
    return;
  }
  const { mime, kind } = picked;

  // Tab/region screen capture (getDisplayMedia + CropTarget/RestrictionTarget) doesn't
  // exist on iOS (every browser there is WebKit) — fall back to redrawing the map +
  // overlays onto an offscreen canvas instead of hard-failing.
  const hasTabCapture = (typeof CropTarget !== 'undefined' || typeof RestrictionTarget !== 'undefined')
    && typeof navigator.mediaDevices?.getDisplayMedia === 'function';

  isRecording = true;
  pauseAnim();
  closeDetail();
  if (isMobile()) closeSidebar();

  const btn = $('btnRecord');
  const playBtn = $('btnPlay');
  btn.disabled = true;
  if (playBtn) playBtn.disabled = true;
  btn.textContent = '준비…';

  try {
    animElapsed = 0;
    lastCamPhaseKey = null;
    lastPopPinIdx = null;
    hideSpotCard();
    hideDayBanner();
    hideEndSummary();
    hideTopProgress();
    hideTripIntro();
    setArrivalBubble(null);
    // Leftover active/visited state from an earlier preview run would otherwise show
    // the whole route as already-traveled in the recording's opening overview shot.
    markers.forEach(m => m._el.classList.remove('active', 'visited'));
    placeChips.forEach(el => el.classList.remove('active', 'visited'));

    if (hasTabCapture) await recordViaTabCapture({ mime, kind, btn });
    else await recordViaCanvas({ mime, kind, btn });
  } catch (err){
    console.error(err);
    if (err && err.message === 'capture ended'){
      alert('탭 공유가 중단되어 저장을 취소했습니다.');
    } else if (!(err && err.message === 'record cancelled')){
      alert('동영상 저장에 실패했습니다. 다시 시도해 주세요.');
    }
  } finally {
    setRecordStatus('');
    btn.disabled = false;
    if (playBtn) playBtn.disabled = false;
    btn.textContent = '📥 저장';
    isRecording = false;
    setTimelineCompact(false);
    camFollow = (OVERVIEW_MODE ? false : true);
    syncMovingMarkerPlaying();
  }
}

/** Chrome/Edge desktop path: capture the real tab, cropped to #mapwrap. Unchanged behavior. */
async function recordViaTabCapture({ mime, kind, btn }){
  const mapwrap = $('mapwrap');
  setRecordStatus('이 탭 공유를 허용해 주세요…');
  mapwrap.classList.add('is-recording');
  setTimelineCompact(true);
  map.resize();

  let displayStream = null;
  try {
    await waitMapFrame();
    await waitMapFrame();

    try {
      displayStream = await navigator.mediaDevices.getDisplayMedia({
        video: { displaySurface: 'browser' },
        audio: false,
        preferCurrentTab: true,
        selfBrowserSurface: 'include',
        monitorTypeSurfaces: 'exclude',
        surfaceSwitching: 'exclude',
        systemAudio: 'exclude'
      });
    } catch (permErr){
      if (permErr && (permErr.name === 'NotAllowedError' || permErr.name === 'AbortError')){
        alert('탭 공유가 취소되었습니다. 저장하려면 «이 탭»을 공유해 주세요.');
        throw new Error('record cancelled');
      }
      throw permErr;
    }

    const videoTrack = displayStream.getVideoTracks()[0];
    if (!videoTrack) throw new Error('no video track');

    try {
      if (typeof RestrictionTarget !== 'undefined' && typeof videoTrack.restrictTo === 'function'){
        const restrictionTarget = await RestrictionTarget.fromElement(mapwrap);
        await videoTrack.restrictTo(restrictionTarget);
      } else {
        const cropTarget = await CropTarget.fromElement(mapwrap);
        await videoTrack.cropTo(cropTarget);
      }
    } catch (cropErr){
      console.error(cropErr);
      alert('지도 영역만 캡처할 수 없습니다. 공유 대상에서 «이 탭»을 선택해 주세요.');
      throw new Error('record cancelled');
    }

    const fps = 30;
    const frameDt = 1000 / fps;
    const chunks = [];
    const rec = new MediaRecorder(displayStream, { mimeType: mime, videoBitsPerSecond: 8_000_000 });
    rec.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };
    const stopped = new Promise((resolve, reject) => {
      rec.onstop = resolve;
      rec.onerror = ev => reject(ev.error || new Error('MediaRecorder error'));
    });
    rec.start(100);

    const speed = Number($('tlSpeed').value) || 1;
    syncMovingMarkerPlaying();
    startCineIntro();
    await waitMapFrame();
    await waitMapFrame();

    const introMs = INTRO_OVERVIEW_MS + INTRO_ZOOM_MS + INTRO_HOLD_MS;
    const outroMs = OUTRO_HOLD_MS + OUTRO_ZOOM_MS;
    const totalMs = introMs + animTotal + outroMs;
    const maxFrames = Math.ceil((totalMs / speed) / frameDt) + fps * 2;
    let frames = 0;
    let done = false;

    btn.textContent = '0%';
    setRecordStatus('녹화 중 0%');

    while (!done && frames++ < maxFrames){
      if (videoTrack.readyState !== 'live') throw new Error('capture ended');
      const animDt = frameDt * speed;
      done = tickPlayback(animDt);
      await waitMapFrame();
      let progress = 0;
      if (cineMode === 'intro') progress = (cineElapsed / introMs) * 8;
      else if (cineMode === 'main' || cineMode === 'outro'){
        progress = 8 + (animElapsed / Math.max(1, animTotal)) * 84;
        if (cineMode === 'outro') progress = 92 + Math.min(8, (cineElapsed / outroMs) * 8);
      } else progress = 100;
      const pct = Math.max(0, Math.min(100, Math.round(progress)));
      btn.textContent = pct + '%';
      setRecordStatus('녹화 중 ' + pct + '%');
      await new Promise(r => setTimeout(r, Math.max(8, frameDt - 4)));
    }

    showEndSummary();
    for (let i = 0; i < Math.round(fps * 0.8); i++){
      if (videoTrack.readyState !== 'live') break;
      await new Promise(r => setTimeout(r, frameDt));
    }

    if (rec.state !== 'inactive') rec.stop();
    await stopped;

    let blob = new Blob(chunks, { type: mime });
    if (!blob.size) throw new Error('empty video');

    displayStream.getTracks().forEach(t => t.stop());
    displayStream = null;
    mapwrap.classList.remove('is-recording');
    map.resize();

    if (kind !== 'mp4'){
      setRecordStatus('MP4 변환 중…');
      btn.textContent = '변환…';
      blob = await toMp4Blob(blob, pct => {
        setRecordStatus('MP4 변환 ' + pct + '%');
        btn.textContent = pct + '%';
      });
    } else {
      blob = new Blob([blob], { type: 'video/mp4' });
    }
    if (!blob.size) throw new Error('empty mp4');

    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    await saveVideoBlob(blob, `travel-route-${stamp}.mp4`);
    setRecordStatus('MP4 저장 완료');
    await new Promise(r => setTimeout(r, 600));
  } finally {
    if (displayStream){
      try { displayStream.getTracks().forEach(t => t.stop()); } catch (e) { /* ignore */ }
    }
    mapwrap.classList.remove('is-recording');
    try { map.resize(); } catch (e) { /* ignore */ }
  }
}

/**
 * iOS fallback path: no screen-capture API exists there, so redraw the map canvas +
 * pins + overlay cards onto an offscreen canvas every frame (drawExportFrame) and
 * record that canvas directly. No permission prompt needed.
 */
async function recordViaCanvas({ mime, kind, btn }){
  setRecordStatus('녹화 준비 중…');
  await waitMapFrame();
  await waitMapFrame();

  const mapCanvas = map.getCanvas();
  const out = document.createElement('canvas');
  out.width = mapCanvas.width;
  out.height = mapCanvas.height;
  const ctx = out.getContext('2d', { alpha: false });

  const markerImgs = await Promise.all(clusters.map(c => loadImage(c.rep.url)));
  const slideImgMap = new Map();
  const slideUrls = [];
  clusters.forEach(c => slidePhotosForCluster(c).forEach(p => {
    if (!slideImgMap.has(p.url)){ slideImgMap.set(p.url, null); slideUrls.push(p.url); }
  }));
  await Promise.all(slideUrls.map(async url => {
    slideImgMap.set(url, await loadImage(url));
  }));
  const iconSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="${progressColor}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${MARKER_ICON_PATHS[movingIconType] || ''}</svg>`;
  const exportIconImg = await loadImage('data:image/svg+xml;charset=utf-8,' + encodeURIComponent(iconSvg));

  const fps = 30;
  const frameDt = 1000 / fps;
  // Manual capture: push exactly one video frame per drawExportFrame() call instead of
  // letting captureStream sample the canvas on its own timer — a slow device (iPhone)
  // can't guarantee a steady 30fps draw loop, and auto-sampling against that produces
  // duplicated/dropped frames (visible as stutter) since it captures on its own clock.
  const manualCapture = (() => {
    try { return typeof out.captureStream(0).getVideoTracks()[0].requestFrame === 'function'; }
    catch (e) { return false; }
  })();
  const stream = manualCapture ? out.captureStream(0) : out.captureStream(fps);
  const track = stream.getVideoTracks()[0];
  const pushFrame = manualCapture ? () => track.requestFrame() : () => {};
  const recStart = performance.now();
  const chunks = [];
  const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 8_000_000 });
  rec.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };
  const stopped = new Promise((resolve, reject) => {
    rec.onstop = resolve;
    rec.onerror = ev => reject(ev.error || new Error('MediaRecorder error'));
  });
  rec.start(100);

  const speed = Number($('tlSpeed').value) || 1;
  syncMovingMarkerPlaying();
  startCineIntro();
  await waitMapFrame();
  await waitMapFrame();

  const introMs = INTRO_OVERVIEW_MS + INTRO_ZOOM_MS + INTRO_HOLD_MS;
  const outroMs = OUTRO_HOLD_MS + OUTRO_ZOOM_MS;
  const totalMs = introMs + animTotal + outroMs;
  const maxFrames = Math.ceil((totalMs / speed) / frameDt) + fps * 2;
  let frames = 0;
  let done = false;

  btn.textContent = '0%';
  setRecordStatus('녹화 중 0%');

  while (!done && frames++ < maxFrames){
    const animDt = frameDt * speed;
    done = tickPlayback(animDt);
    await waitMapFrame();
    const visited = new Set();
    markers.forEach((m, i) => { if (m._el.classList.contains('visited')) visited.add(i); });
    drawExportFrame(ctx, out.width, out.height, markerImgs, exportIconImg, visited, slideImgMap, performance.now() - recStart);
    pushFrame();
    let progress = 0;
    if (cineMode === 'intro') progress = (cineElapsed / introMs) * 8;
    else if (cineMode === 'main' || cineMode === 'outro'){
      progress = 8 + (animElapsed / Math.max(1, animTotal)) * 84;
      if (cineMode === 'outro') progress = 92 + Math.min(8, (cineElapsed / outroMs) * 8);
    } else progress = 100;
    const pct = Math.max(0, Math.min(100, Math.round(progress)));
    btn.textContent = pct + '%';
    setRecordStatus('녹화 중 ' + pct + '%');
    await new Promise(r => setTimeout(r, Math.max(8, frameDt - 4)));
  }

  showEndSummary();
  const visitedEnd = new Set(clusters.map((_, i) => i));
  for (let i = 0; i < Math.round(fps * 0.8); i++){
    drawExportFrame(ctx, out.width, out.height, markerImgs, exportIconImg, visitedEnd, slideImgMap, performance.now() - recStart);
    pushFrame();
    await new Promise(r => setTimeout(r, frameDt));
  }

  if (rec.state !== 'inactive') rec.stop();
  await stopped;

  let blob = new Blob(chunks, { type: mime });
  if (!blob.size) throw new Error('empty video');

  if (kind !== 'mp4'){
    setRecordStatus('MP4 변환 중…');
    btn.textContent = '변환…';
    blob = await toMp4Blob(blob, pct => {
      setRecordStatus('MP4 변환 ' + pct + '%');
      btn.textContent = pct + '%';
    });
  } else {
    blob = new Blob([blob], { type: 'video/mp4' });
  }
  if (!blob.size) throw new Error('empty mp4');

  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  await saveVideoBlob(blob, `travel-route-${stamp}.mp4`);
  setRecordStatus('MP4 저장 완료');
  await new Promise(r => setTimeout(r, 600));
}

(() => {
  const card = document.querySelector('#endSummary .es-card');
  if (!card) return;
  let startY = null;
  card.addEventListener('click', () => hideEndSummary());
  card.addEventListener('pointerdown', e => { startY = e.clientY; });
  card.addEventListener('pointermove', e => {
    if (startY == null) return;
    if (e.clientY - startY > 40){ hideEndSummary(); startY = null; }
  });
  card.addEventListener('pointerup', () => { startY = null; });
})();

$('btnPlay').addEventListener('click', () => {
  if (isRecording) return;
  if (isPlaying) pauseAnim();
  else playAnim();
});
$('btnRecord').addEventListener('click', () => { recordAndDownload(); });
$('btnReplay').addEventListener('click', () => {
  if (isRecording) return;
  pauseAnim();
  cancelPlayIntro();
  animElapsed = 0;
  cineMode = 'idle';
  setTimelineCompact(false);
  hideSpotCard();
  hideDayBanner();
  hideEndSummary();
  hideTopProgress();
  hideTripIntro();
  camFollow = false;
  camZoom = null; camLon = null; camLat = null;
  lastPopPinIdx = null;
  renderFrame(0);
  fitToClusters();
});
$('tlRange').addEventListener('input', e => {
  if (isRecording) return;
  pauseAnim();
  cancelPlayIntro();
  cineMode = 'main';
  hideEndSummary();
  hideTripIntro();
  animElapsed = Number(e.target.value)/1000 * animTotal;
  camFollow = (OVERVIEW_MODE ? false : true);
  renderFrame(animElapsed);
});
$('btnFitAll').addEventListener('click', () => {
  if (!clusters.length || isRecording) return;
  fitToClusters();
});
$('btnTripTitle').addEventListener('click', () => {
  if (!clusters.length) return;
  const val = prompt('여행 제목', getTripTitle());
  if (val === null) return;
  setTripTitleCustom(val);
});

/* ============ Utils ============ */
function fmtDateShort(d){
  if (!(d instanceof Date) || isNaN(d)) return '-';
  return `${d.getFullYear()}.${String(d.getMonth()+1).padStart(2,'0')}.${String(d.getDate()).padStart(2,'0')}`;
}
function fmtDateTime(d){
  if (!(d instanceof Date) || isNaN(d)) return '-';
  return `${fmtDateShort(d)} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
}
function dateKey(d){
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

initMap();
