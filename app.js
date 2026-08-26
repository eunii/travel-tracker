"use strict";

/* APP_MODE is set by an inline <script> in focus.html / overview.html before this
   file loads — it only picks the INITIAL mode now. 'overview' = camera stays fixed on
   the whole-trip view; only the traveling marker moves. Anything else (or unset) =
   original camera-follow behavior. The settings sheet's "지도 모드" segment reassigns
   this at runtime via switchMapMode() so switching modes never reloads the page or
   loses loaded photos. */
let OVERVIEW_MODE = (window.APP_MODE === 'overview');

/* ============ State ============ */
let allPhotos = [];        // {file,url,lat,lon,time,w,h}
let clusters = [];         // ordered chronologically {lat,lon,photos[],rep,startTime,endTime}
let markers = [];
let activeCluster = null;
let map = null;
let movingMarker = null;
let pathColor = '#94a3b8';       // full / upcoming route (dashed) — overwritten by the
let progressColor = '#0ea5e9';   // traveled line + marker icon — active theme preset on load
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

// Popup stacking: whichever overlay (detail panel, spot card, trip intro, end summary)
// was opened most recently gets bumped above the rest via inline z-index — starting
// well above .photo-marker's highest z-index (6) so pins never cover an open popup.
let popupZTop = 20;
function bringPopupToFront(el){
  if (!el) return;
  popupZTop += 1;
  el.style.zIndex = String(popupZTop);
}

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
const LS_THEME_PRESET = 'travel-tracker-theme-preset';

let tripTitleCustom = null;
try {
  const savedTitle = localStorage.getItem(LS_TRIP_TITLE);
  if (savedTitle != null && savedTitle !== '') tripTitleCustom = savedTitle;
} catch (e) { /* ignore */ }

let dayTimelineState = null;      // {day, name} of current place, for the simplified canvas-export badge
let dayTimelineCurrentDay = null; // day number currently rendered in the dot-track card
let dayTimelineStops = [];        // [{cluster, el}] for the currently rendered day, in order
let dayTimelineConnectors = [];   // [.dt-connector-fill elements] between consecutive stops
let dayTimelineLastCurrentIdx = null; // last currentIdx scrolled to, to avoid redundant scrollIntoView calls
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

/** Lives in #appbar's #btnThemeToggle now (was a floating MapLibre control). */
function toggleMapTheme(){
  mapTheme = mapTheme === 'dark' ? 'light' : 'dark';
  const btn = $('btnThemeToggle');
  if (btn) btn.textContent = mapTheme === 'dark' ? 'light_mode' : 'dark_mode';
  // full replace so custom route sources/layers are cleared cleanly, then
  // restored from the style.load → restoreRouteAfterStyle handler
  map.setStyle(buildMapStyle(mapTheme), { diff: false });
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

  if (!el.classList.contains('show')) bringPopupToFront(el);
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

/**
 * Day timeline (persistent, always visible once a trip is loaded — replaces the old
 * single-place topProgress toast). Shows ONE day's stops as a dot-and-line progress track;
 * the whole card is rebuilt (with a fade-in) only when the current day changes, and just
 * the dot/line fill state is updated every frame otherwise.
 */
function renderDayTimeline(){
  resetDayTimeline();
  const el = $('dayTimeline');
  if (el) el.setAttribute('aria-hidden', clusters.length ? 'false' : 'true');
}

function resetDayTimeline(){
  dayTimelineState = null;
  dayTimelineCurrentDay = null;
  dayTimelineStops = [];
  dayTimelineConnectors = [];
  dayTimelineLastCurrentIdx = null;
  const el = $('dayTimeline');
  if (el) el.innerHTML = '';
}

function buildDayTrack(day){
  const el = $('dayTimeline');
  if (!el) return;
  const dayClusters = clusters.filter(c => c.day === day);
  if (!dayClusters.length) return;

  const card = document.createElement('div');
  card.className = 'dt-card';

  const header = document.createElement('div');
  header.className = 'dt-header';
  const dayLabel = document.createElement('span');
  dayLabel.className = 'dt-day';
  dayLabel.textContent = 'DAY ' + day;
  const dateLabel = document.createElement('span');
  dateLabel.className = 'dt-date';
  dateLabel.textContent = fmtDateShort(dayClusters[0].startTime);
  header.appendChild(dayLabel);
  header.appendChild(dateLabel);
  card.appendChild(header);

  const track = document.createElement('div');
  track.className = 'dt-track';

  dayTimelineStops = [];
  dayTimelineConnectors = [];
  dayClusters.forEach((c, i) => {
    if (i > 0){
      const connector = document.createElement('div');
      connector.className = 'dt-connector';
      const fill = document.createElement('div');
      fill.className = 'dt-connector-fill';
      connector.appendChild(fill);
      track.appendChild(connector);
      dayTimelineConnectors.push(fill);
    }
    const stop = document.createElement('div');
    stop.className = 'dt-stop';
    const dotWrap = document.createElement('div');
    dotWrap.className = 'dt-dot-wrap';
    const dot = document.createElement('span');
    dot.className = 'dt-dot';
    dotWrap.appendChild(dot);
    const name = document.createElement('div');
    name.className = 'dt-stop-name';
    name.textContent = placeTitle(c);
    stop.appendChild(dotWrap);
    stop.appendChild(name);
    track.appendChild(stop);
    dayTimelineStops.push({ cluster: c, el: stop });
  });
  card.appendChild(track);

  el.innerHTML = '';
  el.appendChild(card);
  dayTimelineCurrentDay = day;
  dayTimelineLastCurrentIdx = null;
  requestAnimationFrame(() => card.classList.add('show'));
}

function updateDayTimeline(cluster, localPos){
  if (!cluster) return;
  dayTimelineState = { day: cluster.day, name: placeTitle(cluster) };
  if (cluster.day !== dayTimelineCurrentDay) buildDayTrack(cluster.day);
  const n = dayTimelineStops.length;
  if (!n) return;
  const currentIdx = dayTimelineStops.findIndex(s => s.cluster === cluster);
  const fillPos = Math.max(0, Math.min(n - 1, localPos != null ? localPos : currentIdx));
  dayTimelineStops.forEach((stop, i) => {
    stop.el.classList.toggle('done', i < currentIdx);
    stop.el.classList.toggle('current', i === currentIdx);
  });
  dayTimelineConnectors.forEach((fillEl, i) => {
    const pct = Math.max(0, Math.min(1, fillPos - i)) * 100;
    fillEl.style.width = pct + '%';
  });
  if (currentIdx !== dayTimelineLastCurrentIdx){
    dayTimelineLastCurrentIdx = currentIdx;
    const stopEl = dayTimelineStops[currentIdx].el;
    if (stopEl.scrollIntoView) stopEl.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
  }
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
  bringPopupToFront(el);
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
  bringPopupToFront(el);
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
  // Attribution added before the zoom controls so it stacks first (right under #appbar,
  // above the zoom/compass group) — user asked for it row-aligned just below the top bar.
  map.addControl(new maplibregl.AttributionControl({compact:true}), 'top-right');
  map.addControl(new maplibregl.NavigationControl(), 'top-right');

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

/* ============ Bottom sheets: #sidebar("여행") and #sheetPhotos("사진"), opened via
   #mobileTabBar — universal at every viewport width. ============ */
const SHEET_IDS = ['sidebar', 'sheetPhotos'];
function openSheet(id){
  closeSettings();
  SHEET_IDS.forEach(sid => { if (sid !== id) $(sid).classList.remove('open'); });
  $(id).classList.add('open');
  $('backdrop').classList.add('show');
}
function closeSheet(id){
  $(id).classList.remove('open');
  if (!SHEET_IDS.some(sid => $(sid).classList.contains('open'))) $('backdrop').classList.remove('show');
}
function closeAllSheets(){
  SHEET_IDS.forEach(sid => $(sid).classList.remove('open'));
  $('backdrop').classList.remove('show');
}
function openSidebar(){ openSheet('sidebar'); }
function closeSidebar(){ closeSheet('sidebar'); }
$('sidebarClose').addEventListener('click', closeSidebar);
$('sheetPhotosClose').addEventListener('click', () => closeSheet('sheetPhotos'));
$('backdrop').addEventListener('click', closeAllSheets);
const isMobile = () => window.innerWidth <= 820;

if (/iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream){
  $('iosHint').style.display = 'block';
}
if (isMobile()) openSheet('sheetPhotos'); // 처음엔 열어서 안내가 보이게

function openSettings(){
  const el = $('settingsOverlay');
  if (!el) return;
  closeAllSheets();
  el.classList.add('open');
  el.setAttribute('aria-hidden', 'false');
}
function closeSettings(){
  const el = $('settingsOverlay');
  if (!el) return;
  el.classList.remove('open');
  el.setAttribute('aria-hidden', 'true');
}
if ($('settingsClose')) $('settingsClose').addEventListener('click', closeSettings);
if (location.hash === '#settings') openSettings(); // deep link from index.html's "설정" card
if ($('btnThemeToggle')) $('btnThemeToggle').addEventListener('click', toggleMapTheme);

/* "지도 모드" segment in settings: switches OVERVIEW_MODE in place (no page navigation,
 * no data loss — see the `let OVERVIEW_MODE` declaration up top). */
function updateMapModeButtons(){
  document.querySelectorAll('.map-mode-btn').forEach(btn => {
    btn.classList.toggle('active', (btn.dataset.target === 'overview') === OVERVIEW_MODE);
  });
}
function switchMapMode(toOverview){
  if (toOverview !== OVERVIEW_MODE){
    pauseAnim();
    OVERVIEW_MODE = toOverview;
    camFollow = (OVERVIEW_MODE ? false : true);
    if (clusters.length) fitToClusters();
  }
  updateMapModeButtons();
}
document.querySelectorAll('.map-mode-btn').forEach(btn => {
  btn.addEventListener('click', () => switchMapMode(btn.dataset.target === 'overview'));
});
updateMapModeButtons();

/* Bottom tab bar: 맵/여행/사진/설정. Universal at every viewport width. */
if ($('tabMap')) $('tabMap').addEventListener('click', () => { closeAllSheets(); closeSettings(); });
if ($('tabJourney')) $('tabJourney').addEventListener('click', () => openSheet('sidebar'));
if ($('tabPhotos')) $('tabPhotos').addEventListener('click', () => openSheet('sheetPhotos'));
if ($('tabSettings')) $('tabSettings').addEventListener('click', () => openSettings());

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
  resetDayTimeline();
  closeDetail();
  $('btnPlay').classList.remove('show');
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
  renderDayTimeline();
  renderMarkers();
  renderRoute();
  if (fit){
    setupAnimation();
    camFollow = (OVERVIEW_MODE ? false : true);
    fitToClusters();
    closeSidebar();
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
  document.querySelectorAll(`#placelist .place[data-idx="${idx}"] .name`).forEach(el => { el.textContent = placeTitle(c); });
  const stop = dayTimelineStops.find(s => s.cluster === c);
  if (stop){
    const nameEl = stop.el.querySelector('.dt-stop-name');
    if (nameEl) nameEl.textContent = placeTitle(c);
  }
  if (activeCluster === idx){
    $('dpTitle').textContent = placeTitle(c);
  }
  if (idx === 0) refreshTripTitleUI();
}

/* "여행 스케일" UI was removed from settings for simplicity — travelScale just stays at
 * its default ('day') now, buildClusters() still reads it the same way. */
const SCALE_PRESETS = { day: 150, city: 3000, country: 30000 };
let travelScale = 'day';

/* ============ Theme presets ============ */
/* A short curated list of matched (path, progress) color pairs, instead of two
   independent free-form pickers — mixing any two colors too easily looked bad, so we
   just offer a handful of pre-matched combos to choose from. */
const THEME_PRESETS = [
  { id:'glacier', label:'Glacier', path:'#94a3b8', progress:'#0ea5e9' },
  { id:'kinetic-path', label:'Kinetic Path', path:'#f97316', progress:'#2563eb' },
  { id:'neon-tokyo', label:'Neon Tokyo', path:'#ec4899', progress:'#eab308' },
  { id:'electric-nightscape', label:'Electric Nightscape', path:'#7c3aed', progress:'#e11d48' }
];
let themePresetId = THEME_PRESETS[0].id;

function buildThemePresetList(){
  const box = $('themePresetList');
  if (!box) return;
  box.innerHTML = '';
  THEME_PRESETS.forEach(p => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'theme-preset-row' + (p.id === themePresetId ? ' active' : '');
    btn.dataset.preset = p.id;
    const swatch = document.createElement('span');
    swatch.className = 'theme-preset-swatch';
    swatch.style.setProperty('--sw-path', p.path);
    swatch.style.setProperty('--sw-progress', p.progress);
    const label = document.createElement('span');
    label.textContent = p.label;
    btn.appendChild(swatch);
    btn.appendChild(label);
    btn.addEventListener('click', () => selectThemePreset(p.id));
    box.appendChild(btn);
  });
}

function selectThemePreset(id){
  const preset = THEME_PRESETS.find(p => p.id === id) || THEME_PRESETS[0];
  themePresetId = preset.id;
  pathColor = preset.path;
  progressColor = preset.progress;
  document.documentElement.style.setProperty('--path', pathColor);
  document.documentElement.style.setProperty('--progress', progressColor);
  try { localStorage.setItem(LS_THEME_PRESET, themePresetId); } catch (e) { /* ignore */ }
  const box = $('themePresetList');
  if (box) box.querySelectorAll('.theme-preset-row').forEach(b => {
    b.classList.toggle('active', b.dataset.preset === themePresetId);
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

(function restoreThemePreset(){
  try {
    const saved = localStorage.getItem(LS_THEME_PRESET);
    if (saved && THEME_PRESETS.some(p => p.id === saved)) themePresetId = saved;
  } catch (e) { /* ignore */ }
})();
buildThemePresetList();
selectThemePreset(themePresetId);

/* "도착 연출" UI was removed from settings for simplicity — arrivalMode still restores
 * from a prior choice if one was saved, otherwise stays at its default ('move'). */
(function restoreArrivalMode(){
  try {
    const saved = localStorage.getItem(LS_ARRIVAL_MODE);
    if (saved === 'move' || saved === 'popup') arrivalMode = saved;
    else {
      const legacy = localStorage.getItem(LS_PHOTO_FAN_LEGACY);
      if (legacy === '1') arrivalMode = 'popup';
      else if (legacy === '0') arrivalMode = 'move';
    }
  } catch (e) { /* ignore */ }
})();

/** Rebuilds the moving marker's DOM — just the progress-color dot, no icon badge. */
function applyMarkerIcon(){
  if (!movingMarker) return;
  const el = movingMarker.getElement();
  const keepBubble = arrivalBubbleLabel;
  el.className = 'moving-marker';
  el.innerHTML = '<span class="core"></span>';
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

let selectedDay = null;

/** Distinct day numbers present in `clusters`, in order. */
function dayNumbers(){
  const days = [];
  clusters.forEach(c => { if (!days.includes(c.day)) days.push(c.day); });
  return days;
}

/** Day1/Day2/… pill tabs above the place list — picking one filters renderPlaceList
 * to just that day, replacing the old always-scrolling list with inline day headers. */
function renderDayTabs(){
  const wrap = $('dayTabs');
  if (!wrap) return;
  wrap.innerHTML = '';
  const days = dayNumbers();
  if (!days.length){ selectedDay = null; return; }
  if (!days.includes(selectedDay)) selectedDay = days[0];
  days.forEach(d => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'day-tab' + (d === selectedDay ? ' active' : '');
    btn.textContent = 'Day ' + d;
    btn.addEventListener('click', () => {
      selectedDay = d;
      renderDayTabs();
      renderPlaceList();
    });
    wrap.appendChild(btn);
  });
  const del = document.createElement('button');
  del.type = 'button';
  del.className = 'day-tab-del material-symbols-outlined';
  del.title = `Day ${selectedDay} 전체 삭제`;
  del.textContent = 'delete';
  del.addEventListener('click', () => deleteDay(selectedDay));
  wrap.appendChild(del);
}

/** Renders the 여행 list — each row opens the same #detailpanel a map pin click does
 * (selectCluster), so there is exactly one place to view/edit/delete a place's photos. */
function renderPlaceList(){
  renderDayTabs();
  const list = $('placelist');
  list.innerHTML = '';
  const visible = clusters
    .map((c, i) => ({ c, i }))
    .filter(({ c }) => selectedDay == null || c.day === selectedDay);

  visible.forEach(({ c, i }) => {
    const row = document.createElement('div');
    row.className = 'place';
    row.dataset.idx = i;

    const thumb = document.createElement('div');
    thumb.className = 'thumb';
    thumb.style.backgroundImage = `url(${c.rep.url})`;
    if (c.photos.length > 1){
      const badge = document.createElement('div');
      badge.className = 'badge';
      badge.textContent = String(c.photos.length);
      thumb.appendChild(badge);
    }

    const meta = document.createElement('div');
    meta.className = 'meta';
    const nameEl = document.createElement('div');
    nameEl.className = 'name';
    nameEl.textContent = c.customName || c.placeName || `장소 ${i+1}`;
    const subEl = document.createElement('div');
    subEl.className = 'sub';
    subEl.textContent = `${fmtTimeShort(c.startTime)} · 사진 ${c.photos.length}장`;
    meta.appendChild(nameEl);
    meta.appendChild(subEl);

    row.appendChild(thumb);
    row.appendChild(meta);

    const locate = document.createElement('button');
    locate.type = 'button';
    locate.className = 'list-locate material-symbols-outlined';
    locate.title = '지도에서 보기';
    locate.textContent = 'my_location';
    locate.addEventListener('click', e => {
      e.stopPropagation();
      selectCluster(i, true);
    });
    row.appendChild(locate);
    row.addEventListener('click', () => selectCluster(i, true));
    list.appendChild(row);
  });
}
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
  $('placelist').querySelectorAll('.place').forEach(el => el.classList.toggle('active', Number(el.dataset.idx)===i));
  const c = clusters[i];
  if (fly && !OVERVIEW_MODE){
    camFollow = false;
    map.flyTo({ center:[c.lon,c.lat], zoom: Math.max(map.getZoom(),14), duration:400, essential:true });
  }

  $('dpTitle').textContent = placeTitle(c);
  const dayBadge = $('dpDayBadge');
  if (dayBadge) dayBadge.textContent = 'DAY ' + c.day;
  $('dpSub').textContent = `${fmtDateTime(c.startTime)}${c.endTime>c.startTime ? ' ~ '+fmtDateTime(c.endTime) : ''} · 위도 ${c.lat.toFixed(5)}, 경도 ${c.lon.toFixed(5)}`;
  const galleryHead = $('dpGalleryHead');
  if (galleryHead) galleryHead.textContent = `사진 ${c.photos.length}장`;
  const grid = $('dpGrid'); grid.innerHTML = '';
  c.photos.forEach((p, pi) => {
    const div = document.createElement('div');
    div.className = 'ph';
    div.style.backgroundImage = `url(${p.url})`;
    div.title = p.name;
    div.addEventListener('click', () => openLightbox(c.photos, pi));
    const del = document.createElement('button');
    del.className = 'ph-del material-symbols-outlined';
    del.type = 'button';
    del.title = '이 사진 삭제';
    del.textContent = 'close';
    del.addEventListener('click', e => {
      e.stopPropagation();
      if (confirm('이 사진을 삭제할까요?')) deletePhoto(p, c);
    });
    div.appendChild(del);
    grid.appendChild(div);
  });
  bringPopupToFront($('detailpanel'));
  $('detailpanel').classList.add('show');
  closeSidebar();
  updateNavButtons();
}

/* Prev/next floating buttons — jump between clusters in list order, reusing selectCluster. */
function updateNavButtons(){
  const prev = $('navPrev'), next = $('navNext');
  if (prev) prev.disabled = !(clusters.length > 1 && activeCluster > 0);
  if (next) next.disabled = !(clusters.length > 1 && activeCluster !== null && activeCluster < clusters.length - 1);
}
function goToPrevCluster(){
  if (activeCluster === null || activeCluster <= 0) return;
  selectCluster(activeCluster - 1, true);
}
function goToNextCluster(){
  if (activeCluster === null || activeCluster >= clusters.length - 1) return;
  selectCluster(activeCluster + 1, true);
}
function closeDetail(){
  $('detailpanel').classList.remove('show');
  activeCluster = null;
  markers.forEach(m => m._el.classList.remove('active'));
  updateNavButtons();
}
$('dpClose').addEventListener('click', closeDetail);
if ($('navPrev')) $('navPrev').addEventListener('click', goToPrevCluster);
if ($('navNext')) $('navNext').addEventListener('click', goToNextCluster);
if ($('dpAddPhotos')) $('dpAddPhotos').addEventListener('click', () => $('filesInput').click());
$('dpEdit').addEventListener('click', () => {
  if (activeCluster === null) return;
  const c = clusters[activeCluster];
  const current = c.customName || c.placeName || `장소 ${activeCluster+1}`;
  const val = prompt('장소 이름 바꾸기', current);
  if (val === null) return;
  c.customName = val.trim() || undefined;
  renderPlaceList();
  renderDayTimeline();
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
    $('empty').innerHTML = '아직 불러온 사진이 없습니다.<br>위 폴더 선택 버튼으로 시작해 보세요.';
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
    $('btnPlay').classList.remove('show');
    return false;
  }
  $('btnPlay').classList.add('show');
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
  hideEndSummary();
  resetDayTimeline();
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
    setArrivalBubble(null);
    updateDayTimeline(c, null);
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
    const nearCluster = clusters[nearIdx];
    let localPos;
    if (a.day === b.day){
      const dayClusters = clusters.filter(x => x.day === a.day);
      localPos = dayClusters.indexOf(a) + eased;
    } else {
      const dayClusters = clusters.filter(x => x.day === nearCluster.day);
      localPos = nearCluster === a ? dayClusters.length - 1 : 0;
    }
    updateDayTimeline(nearCluster, localPos);
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
  $('placelist').querySelectorAll('.place').forEach(el => {
    const idx = Number(el.dataset.idx);
    el.classList.toggle('active', idx === nearIdx);
    el.classList.toggle('visited', idx <= reachedIdx);
  });
}

function renderIntroFrame(dtSec){
  const c0 = clusters[0];
  if (movingMarker) movingMarker.setLngLat([c0.lon, c0.lat]);
  if (cineStage === 0){
    camLon = overviewLon; camLat = overviewLat; camZoom = overviewZoom;
    if (!OVERVIEW_MODE) map.jumpTo({ center: [camLon, camLat], zoom: camZoom });
    showTripIntro();
    hideSpotCard();
  } else if (cineStage === 1){
    hideTripIntro();
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
    updateDayTimeline(c0, 0);
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
  resetDayTimeline();
  showTripIntro();
  if (movingMarker) movingMarker.setLngLat([clusters[0].lon, clusters[0].lat]);
}

function startCineOutro(){
  hideSpotCard();
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
  const speed = 1; // speed selector removed — always real-time now
  const dt = rawDt * speed;
  lastFrameTs = ts;
  const done = tickPlayback(dt);
  if (done){
    pauseAnim();
    resetDayTimeline();
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

/** Drives the #btnPlay play/pause glyph (CSS content, see style.css) — no more expand/
 * collapse timeline card now that the bar has been stripped down to just this button. */
function setPlayingState(on){
  const btn = $('btnPlay');
  if (!btn) return;
  btn.classList.toggle('is-playing', !!on);
}

function playAnim(){
  if (clusters.length < 2 || isRecording) return;
  // Reset map state before playing — closes any open place detail (which can be flown to
  // a specific pin and cover most of the screen) so playback always starts from a clean map.
  closeDetail();
  cancelPlayIntro();
  hideEndSummary();
  setPlayingState(true);

  if (cineMode === 'intro' || cineMode === 'outro'){
    isPlaying = true;
    lastFrameTs = null;
    syncMovingMarkerPlaying();
    rafId = requestAnimationFrame(stepAnim);
    return;
  }

  if (animElapsed >= animTotal) animElapsed = 0;

  if (animElapsed === 0){
    startCineIntro();
    isPlaying = true;
    lastFrameTs = null;
    syncMovingMarkerPlaying();
    rafId = requestAnimationFrame(stepAnim);
    return;
  }

  cineMode = 'main';
  camFollow = (OVERVIEW_MODE ? false : true);
  isPlaying = true;
  lastFrameTs = null;
  syncMovingMarkerPlaying();
  rafId = requestAnimationFrame(stepAnim);
}

function pauseAnim(){
  cancelPlayIntro();
  isPlaying = false;
  if (rafId) cancelAnimationFrame(rafId);
  rafId = null;
  syncMovingMarkerPlaying();
  // While recording, keep showing the pause glyph even though isRecording short-circuits
  // the state reset below — recording always runs the animation start to finish.
  if (!isRecording) setPlayingState(false);
}

function stopAnim(){
  pauseAnim();
  animElapsed = 0;
  cineMode = 'idle';
  setArrivalBubble(null);
  hideSpotCard();
  hideEndSummary();
  resetDayTimeline();
  hideTripIntro();
  lastCamPhaseKey = null;
  lastPopPinIdx = null;
  setPlayingState(false);
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

// The canvas export path (recordViaCanvas, iOS fallback) redraws all overlay text
// itself instead of capturing the DOM, so it must explicitly match the app's
// --font-body (Pretendard) or the saved video's text renders in the platform's
// generic sans-serif instead of what the preview shows.
let exportFontStackCache = null;
function exportFontStack(){
  if (!exportFontStackCache){
    const v = getComputedStyle(document.documentElement).getPropertyValue('--font-body').trim();
    exportFontStackCache = v || 'sans-serif';
  }
  return exportFontStackCache;
}

/** Ensures Pretendard is actually loaded before the canvas export draws any text
 * (canvas silently falls back to the platform default otherwise, even with the
 * right font-family string) — awaited once before the recordViaCanvas frame loop. */
async function waitExportFontsReady(){
  const stack = exportFontStack();
  const weights = ['400', '600', '700'];
  try {
    await Promise.all(weights.map(w => document.fonts.load(`${w} 16px ${stack}`)));
    await document.fonts.ready;
  } catch (e) { /* best effort — fall back to whatever is available */ }
}

/**
 * iOS fallback recording path: redraw the map canvas + pins + overlay cards onto an
 * offscreen canvas every frame (used with canvas.captureStream, see recordViaCanvas).
 * iOS has no getDisplayMedia/CropTarget, so there is no way to record the real DOM there.
 */
function drawExportFrame(ctx, outW, outH, markerImgs, visitedSet, slideImgMap){
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
      ctx.fillStyle = '#fff';
      ctx.font = `bold ${11 * Math.min(sx, sy)}px ${exportFontStack()}`;
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
    if (arrivalBubbleLabel && arrivalMode === 'move' && !spotCardState){
      const fontPx = Math.max(11, 12 * s);
      ctx.font = `600 ${fontPx}px ${exportFontStack()}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const padX = 10 * s, padY = 6 * s;
      const textW = ctx.measureText(arrivalBubbleLabel).width;
      const bw = Math.min(200 * s, textW + padX * 2);
      const bh = fontPx + padY * 2;
      const bx = x - bw / 2;
      const by = y - core - 8 * s - bh - 8 * s;
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

  // Unified overlays: simplified "DAY N + current place" badge (full day-timeline breadcrumb
  // is DOM-only — replicating its wrapped multi-day layout in canvas isn't worth the complexity)
  // + bottom photo (popup only)
  if (dayTimelineState && !tripIntroVisible){
    const s = Math.min(sx, sy);
    const badgeD = 28 * s;
    const padY = 8 * s, padL = 8 * s, padR = 16 * s, gap = 10 * s;
    const name = dayTimelineState.name || '';
    const order = 'DAY ' + dayTimelineState.day;
    ctx.font = `600 ${Math.max(13, 15 * s)}px ${exportFontStack()}`;
    const nameW = ctx.measureText(name).width;
    ctx.font = `700 ${Math.max(10, 10.5 * s)}px ${exportFontStack()}`;
    const orderW = ctx.measureText(order).width;
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
    ctx.fillStyle = 'rgba(46,178,124,0.25)';
    ctx.fill();
    ctx.font = `${Math.max(12, 14 * s)}px ${exportFontStack()}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('📍', badgeCx, badgeCy + 0.5 * s);

    const textX = bx + padL + badgeD + gap;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillStyle = '#2eb27c';
    ctx.font = `700 ${Math.max(10, 10.5 * s)}px ${exportFontStack()}`;
    ctx.fillText(order, textX, by + cardH / 2 - 13 * s, cardW - (textX - bx) - padR);
    ctx.fillStyle = '#e8ebf3';
    ctx.font = `600 ${Math.max(13, 15 * s)}px ${exportFontStack()}`;
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
    ctx.font = `700 ${Math.max(18, 22 * s)}px ${exportFontStack()}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(getTripTitle(), outW / 2, by + 38 * s, cardW - 28 * s);
    ctx.fillStyle = '#5a6b5e';
    ctx.font = `700 ${Math.max(12, 14 * s)}px ${exportFontStack()}`;
    ctx.fillText(stay.n > 1 ? stay.ko + ' · ' + stay.en : stay.en, outW / 2, by + 68 * s);
    ctx.fillStyle = '#667085';
    ctx.font = `${Math.max(11, 12 * s)}px ${exportFontStack()}`;
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
      ctx.font = `${Math.max(10, 11 * s)}px ${exportFontStack()}`;
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
      ctx.font = `700 ${Math.max(14, 18 * s)}px ${exportFontStack()}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(c[0], cx, by + 32 * s);
      ctx.fillStyle = '#667085';
      ctx.font = `${Math.max(9, 10 * s)}px ${exportFontStack()}`;
      ctx.fillText(c[1], cx, by + 52 * s);
    });
    ctx.fillStyle = '#667085';
    ctx.font = `${Math.max(10, 11 * s)}px ${exportFontStack()}`;
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
  closeSidebar();

  const playBtn = $('btnPlay');
  if (playBtn) playBtn.disabled = true;
  setRecordStatus('준비…');

  try {
    animElapsed = 0;
    lastCamPhaseKey = null;
    lastPopPinIdx = null;
    hideSpotCard();
    hideEndSummary();
    resetDayTimeline();
    hideTripIntro();
    setArrivalBubble(null);
    // Leftover active/visited state from an earlier preview run would otherwise show
    // the whole route as already-traveled in the recording's opening overview shot.
    markers.forEach(m => m._el.classList.remove('active', 'visited'));
    $('placelist').querySelectorAll('.place').forEach(el => el.classList.remove('active', 'visited'));

    if (hasTabCapture) await recordViaTabCapture({ mime, kind });
    else await recordViaCanvas({ mime, kind });
  } catch (err){
    console.error(err);
    if (err && err.message === 'capture ended'){
      alert('탭 공유가 중단되어 저장을 취소했습니다.');
    } else if (!(err && err.message === 'record cancelled')){
      alert('동영상 저장에 실패했습니다. 다시 시도해 주세요.');
    }
  } finally {
    setRecordStatus('');
    if (playBtn) playBtn.disabled = false;
    isRecording = false;
    setPlayingState(false);
    camFollow = (OVERVIEW_MODE ? false : true);
    syncMovingMarkerPlaying();
  }
}

/** Chrome/Edge desktop path: capture the real tab, cropped to #mapwrap. Unchanged behavior. */
async function recordViaTabCapture({ mime, kind }){
  const mapwrap = $('mapwrap');
  setRecordStatus('이 탭 공유를 허용해 주세요…');
  mapwrap.classList.add('is-recording');
  setPlayingState(true);
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

    const speed = 1; // speed selector removed — always real-time now
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
      blob = await toMp4Blob(blob, pct => {
        setRecordStatus('MP4 변환 ' + pct + '%');
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
async function recordViaCanvas({ mime, kind }){
  setRecordStatus('녹화 준비 중…');
  await waitExportFontsReady();
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
  const chunks = [];
  const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 8_000_000 });
  rec.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };
  const stopped = new Promise((resolve, reject) => {
    rec.onstop = resolve;
    rec.onerror = ev => reject(ev.error || new Error('MediaRecorder error'));
  });
  rec.start(100);

  const speed = 1; // speed selector removed — always real-time now
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

  setRecordStatus('녹화 중 0%');

  while (!done && frames++ < maxFrames){
    const animDt = frameDt * speed;
    done = tickPlayback(animDt);
    await waitMapFrame();
    const visited = new Set();
    markers.forEach((m, i) => { if (m._el.classList.contains('visited')) visited.add(i); });
    drawExportFrame(ctx, out.width, out.height, markerImgs, visited, slideImgMap);
    pushFrame();
    let progress = 0;
    if (cineMode === 'intro') progress = (cineElapsed / introMs) * 8;
    else if (cineMode === 'main' || cineMode === 'outro'){
      progress = 8 + (animElapsed / Math.max(1, animTotal)) * 84;
      if (cineMode === 'outro') progress = 92 + Math.min(8, (cineElapsed / outroMs) * 8);
    } else progress = 100;
    const pct = Math.max(0, Math.min(100, Math.round(progress)));
    setRecordStatus('녹화 중 ' + pct + '%');
    await new Promise(r => setTimeout(r, Math.max(8, frameDt - 4)));
  }

  showEndSummary();
  const visitedEnd = new Set(clusters.map((_, i) => i));
  for (let i = 0; i < Math.round(fps * 0.8); i++){
    drawExportFrame(ctx, out.width, out.height, markerImgs, visitedEnd, slideImgMap);
    pushFrame();
    await new Promise(r => setTimeout(r, frameDt));
  }

  if (rec.state !== 'inactive') rec.stop();
  await stopped;

  let blob = new Blob(chunks, { type: mime });
  if (!blob.size) throw new Error('empty video');

  if (kind !== 'mp4'){
    setRecordStatus('MP4 변환 중…');
    blob = await toMp4Blob(blob, pct => {
      setRecordStatus('MP4 변환 ' + pct + '%');
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

/* Play/record merged into one floating button: tap toggles play/pause, a long-press
   (hold ~550ms) confirms and starts the same recording flow the old separate "저장"
   button used to trigger. */
(() => {
  const playBtnEl = $('btnPlay');
  const LONG_PRESS_MS = 550;
  let pressTimer = null;
  let longPressFired = false;
  playBtnEl.addEventListener('pointerdown', () => {
    longPressFired = false;
    pressTimer = setTimeout(() => {
      longPressFired = true;
      if (isRecording || clusters.length < 2) return;
      if (confirm('지금까지의 동선을 동영상으로 저장할까요?')) recordAndDownload();
    }, LONG_PRESS_MS);
  });
  ['pointerup', 'pointerleave', 'pointercancel'].forEach(ev => {
    playBtnEl.addEventListener(ev, () => clearTimeout(pressTimer));
  });
  playBtnEl.addEventListener('click', () => {
    if (longPressFired || isRecording) return;
    if (isPlaying) pauseAnim();
    else playAnim();
  });
})();
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
function fmtTimeShort(d){
  if (!(d instanceof Date) || isNaN(d)) return '-';
  return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
}
function dateKey(d){
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

initMap();
