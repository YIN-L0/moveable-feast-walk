'use strict';

// Places, text and audio are static files; the live inputs are the GPS fix,
// the compass, and (online only) the map tiles and optional walking route.

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const store = {
  get(key, fallback) {
    try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private mode */ }
  },
};

const PARIS = [48.8495, 2.337];
const MAX_ACCURACY_M = 100;     // ignore fixes worse than this for auto-play
const GAP_BETWEEN_SCENES_MS = 4000;
const SILENCE = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=';
const ROUTER = 'https://routing.openstreetmap.de/routed-foot/route/v1/foot/';

const audio = $('audio');
let places = [];
let people = {};
let played = new Set(store.get('played', []));
let pos = null;                 // {lat, lng, accuracy, simulated}
let heading = null;             // degrees clockwise from north
let compassSeen = false;
let current = null;             // {place, scene, phase: 'intro' | 'main'}
let started = false;
let follow = true;
let watchId = null;
let wakeLock = null;
let speaking = false;

let map, meMarker, accCircle, targetLine, routeLine, radiusCircle;
const markers = new Map();      // place id -> {marker, key}

// ---------- geometry ----------

function distanceM(lat1, lng1, lat2, lng2) {
  const R = 6371000, rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad, dLng = (lng2 - lng1) * rad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function bearingLabel(lat1, lng1, lat2, lng2) {
  const rad = Math.PI / 180;
  const y = Math.sin((lng2 - lng1) * rad) * Math.cos(lat2 * rad);
  const x = Math.cos(lat1 * rad) * Math.sin(lat2 * rad) - Math.sin(lat1 * rad) * Math.cos(lat2 * rad) * Math.cos((lng2 - lng1) * rad);
  const deg = (Math.atan2(y, x) / rad + 360) % 360;
  return ['北', '东北', '东', '东南', '南', '西南', '西', '西北'][Math.round(deg / 45) % 8];
}

const fmtDist = (m) => (m < 1000 ? `${Math.round(m)} 米` : `${(m / 1000).toFixed(1)} 公里`);
const fmtDur = (s) => (s ? `${Math.max(1, Math.round(s / 60))} 分钟` : '');
const sourceLine = (s) => `出自 ${s.chapterLabel}《${s.chapterTitle}》`;
// GPS in narrow streets is often 15–30 m off, so widen the trigger a little with the reported error.
const triggerRadius = (p) => p.radiusM + Math.min(pos?.accuracy ?? 0, 30) / 2;
const inRange = (p) => p.dist != null && p.dist <= triggerRadius(p);

// ---------- playback ----------

function nextScene(place, { includeReview = false } = {}) {
  return place.scenes.find((s) => !played.has(s.id) && (includeReview || !s.needsReview));
}

function markPlayed(scene) {
  played.add(scene.id);
  store.set('played', [...played]);
}

function sceneHtml(s) {
  const who = s.people.map((id) => people[id]).filter(Boolean);
  return `
    <div class="source">${esc(sourceLine(s))}${s.englishChapterTitle ? ` · ${esc(s.englishChapterTitle)}` : ''}</div>
    <div class="context">${esc(s.context)}</div>
    ${who.length ? `<details class="people"><summary>这一段里的人物（${who.length}）</summary><dl>
      ${who.map((p) => `<dt>${esc(p.name)}</dt><dd>${esc(p.bio)}</dd>`).join('')}</dl></details>` : ''}`;
}

function setPhase(phase) {
  current.phase = phase;
  const { scene } = current;
  const intro = phase === 'intro';
  $('phase').textContent = intro ? '背景介绍' : '原文朗读';
  $('skipBtn').hidden = !intro;
  speaking = false;
  window.speechSynthesis?.cancel();
  audio.src = intro ? scene.introAudio : scene.audio;
  audio.play().catch(() => speak());
}

function play(place, scene) {
  stop({ mark: false });
  current = { place, scene, phase: 'main' };
  document.body.classList.add('playing');
  $('player').hidden = false;
  $('nowPlace').textContent = place.nameZh;
  $('nowScene').textContent = `${scene.title} · ${scene.chapterLabel}《${scene.chapterTitle}》`;
  $('sceneText').innerHTML = `${sceneHtml(scene)}<div class="label">原文（张佳玮 译）</div>
    <div class="text">${scene.paragraphs.map((p) => `<p>${esc(p)}</p>`).join('')}</div>`;
  if ('mediaSession' in navigator) {
    navigator.mediaSession.metadata = new MediaMetadata({ title: scene.title, artist: place.nameZh, album: '流动的盛宴' });
  }
  setPhase($('introToggle').checked && scene.introAudio ? 'intro' : 'main');
  render();
}

// Fallback when an audio file is missing or not cached: the phone's own voice.
function speak() {
  if (speaking || !('speechSynthesis' in window) || !current) return;
  const playing = current;
  const parts = current.phase === 'intro' ? [current.scene.intro] : current.scene.paragraphs;
  speaking = true;
  speechSynthesis.cancel();
  parts.forEach((text, i) => {
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'zh-CN';
    if (i === parts.length - 1) u.onend = () => { if (speaking && current === playing) { speaking = false; onEnded(); } };
    speechSynthesis.speak(u);
  });
}

function stop({ mark = true } = {}) {
  if (!current) return;
  if (mark) markPlayed(current.scene);
  audio.pause();
  speaking = false;
  window.speechSynthesis?.cancel();
  current = null;
  document.body.classList.remove('playing');
  $('player').hidden = true;
  render();
}

function onEnded() {
  if (!current) return;
  if (current.phase === 'intro') { setPhase('main'); return; }
  stop();
  setTimeout(maybeAutoplay, GAP_BETWEEN_SCENES_MS);
}

function maybeAutoplay() {
  if (!started || current || !pos || !$('autoToggle').checked) return;
  if (!pos.simulated && pos.accuracy > MAX_ACCURACY_M) return;
  const hit = places
    .filter((p) => p.autoplay && inRange(p) && nextScene(p))
    .sort((a, b) => a.dist - b.dist)[0];
  if (hit) {
    navigator.vibrate?.(200);
    play(hit, nextScene(hit));
  }
}

// ---------- location ----------

function onPosition(p) {
  if (pos?.simulated && !p.simulated) return;   // keep the simulated spot until cancelled
  const first = !pos;
  pos = p;
  for (const pl of places) pl.dist = distanceM(p.lat, p.lng, pl.lat, pl.lng);
  const far = distanceM(p.lat, p.lng, ...PARIS) > 25000;
  if (first && far) setFollow(false);
  if (!routeLine) {
    $('status').textContent = p.simulated
      ? '模拟位置（点这里回到真实定位）'
      : `定位精度约 ${Math.round(p.accuracy)} 米${p.accuracy > MAX_ACCURACY_M ? '，信号弱，暂不自动播放' : ''}${far ? ' · 你似乎不在巴黎' : ''}`;
  }
  if (follow) map.setView([p.lat, p.lng], first ? 17 : map.getZoom(), { animate: !first });
  render();
  maybeAutoplay();
}

function watch() {
  if (!window.isSecureContext) { $('status').textContent = '定位需要 HTTPS：请用 https:// 地址打开本页'; return; }
  if (!('geolocation' in navigator)) { $('status').textContent = '此浏览器不支持定位'; return; }
  if (watchId != null) navigator.geolocation.clearWatch(watchId);
  watchId = navigator.geolocation.watchPosition(
    (g) => {
      const c = g.coords;
      // While walking, the direction of travel is a usable heading if there is no compass.
      if (!compassSeen && c.heading != null && !Number.isNaN(c.heading) && c.speed > 0.7) heading = c.heading;
      onPosition({ lat: c.latitude, lng: c.longitude, accuracy: c.accuracy });
    },
    (e) => {
      $('status').textContent = e.code === 1
        ? '定位权限被拒绝：请在 设置 › 隐私 › 定位服务 里允许浏览器定位，然后点 ◎'
        : '暂时拿不到定位（室内或信号弱），继续尝试中…';
    },
    { enableHighAccuracy: true, maximumAge: 3000, timeout: 30000 },
  );
}

function initCompass() {
  const onOrient = (e) => {
    let d = e.webkitCompassHeading;
    if (d == null && e.absolute && e.alpha != null) d = 360 - e.alpha;
    if (d == null) return;
    compassSeen = true;
    heading = d;
    renderMe();
  };
  const listen = () => {
    window.addEventListener('deviceorientationabsolute', onOrient);
    window.addEventListener('deviceorientation', onOrient);
  };
  // iOS only hands out compass data after an explicit prompt from a tap.
  if (typeof DeviceOrientationEvent !== 'undefined' && DeviceOrientationEvent.requestPermission) {
    DeviceOrientationEvent.requestPermission().then((s) => { if (s === 'granted') listen(); }).catch(() => {});
  } else {
    listen();
  }
}

async function keepAwake() {
  try { wakeLock = await navigator.wakeLock?.request('screen'); } catch { /* unsupported or denied */ }
}

function start() {
  if (started) return;
  started = true;
  // Playing something inside the tap unlocks later programmatic playback on iOS.
  audio.src = SILENCE;
  audio.play().catch(() => {});
  $('start').hidden = true;
  $('status').textContent = '正在获取定位…';
  initCompass();
  watch();
  keepAwake();
  map.invalidateSize();
}

function setFollow(on) {
  follow = on;
  $('locateBtn').classList.toggle('on', on);
}

// ---------- map ----------

function initMap(metro) {
  map = L.map('map', { zoomControl: true }).setView(PARIS, 14);
  const osm = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19, attribution: '© OpenStreetMap',
  }).addTo(map);
  const light = L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', {
    maxZoom: 20, subdomains: 'abcd', attribution: '© OpenStreetMap © CARTO',
  });
  const metroLayer = L.layerGroup(metro.map((m) => L.marker([m.lat, m.lng], {
    interactive: false, keyboard: false,
    icon: L.divIcon({
      className: '', iconSize: [16, 16], iconAnchor: [8, 8],
      html: `<div class="metro${m.kind === 'RER' ? ' rer' : ''}"><b>${m.kind === 'RER' ? 'R' : 'M'}</b><span>${esc(m.name)}</span></div>`,
    }),
  })));
  const placeLayer = L.layerGroup().addTo(map);
  for (const p of places) {
    const marker = L.marker([p.lat, p.lng], { zIndexOffset: 500 }).on('click', () => openDetail(p)).addTo(placeLayer);
    markers.set(p.id, { marker, key: '' });
  }
  L.control.layers({ '街道详图': osm, '简洁底图': light }, { '书中地点': placeLayer, '地铁 / RER 站': metroLayer },
    { position: 'topright' }).addTo(map);
  L.control.scale({ imperial: false }).addTo(map);

  // 200 station badges at city zoom is noise: show them from neighbourhood zoom up,
  // unless the user switched the layer off themselves.
  let metroWanted = true, autoToggle = false;
  map.on('overlayremove', (e) => { if (e.layer === metroLayer && !autoToggle) metroWanted = false; });
  map.on('overlayadd', (e) => { if (e.layer === metroLayer && !autoToggle) metroWanted = true; });
  const onZoom = () => {
    const z = map.getZoom();
    map.getContainer().classList.toggle('z16', z >= 16);
    autoToggle = true;
    if (metroWanted && z >= 15) metroLayer.addTo(map);
    else map.removeLayer(metroLayer);
    autoToggle = false;
  };
  map.on('zoomend', onZoom);
  map.on('dragstart', () => setFollow(false));
  fitAll();
  onZoom();
}

function fitAll() {
  const central = places.filter((p) => distanceM(p.lat, p.lng, ...PARIS) < 2500);
  map.fitBounds(L.latLngBounds(central.map((p) => [p.lat, p.lng])).pad(0.08));
}

function renderMe() {
  if (!pos || !map) return;
  const ll = [pos.lat, pos.lng];
  if (!meMarker) {
    accCircle = L.circle(ll, { radius: pos.accuracy, color: '#2f7de1', weight: 1, fillOpacity: 0.1, interactive: false }).addTo(map);
    meMarker = L.marker(ll, {
      interactive: false, zIndexOffset: 1000,
      icon: L.divIcon({ className: '', iconSize: [22, 22], iconAnchor: [11, 11], html: '<div class="me"><div class="cone"></div><div class="dot"></div></div>' }),
    }).addTo(map);
  }
  meMarker.setLatLng(ll);
  accCircle.setLatLng(ll).setRadius(pos.accuracy);
  const el = meMarker.getElement()?.firstChild;
  if (el) {
    el.classList.toggle('hasHeading', heading != null);
    if (heading != null) el.querySelector('.cone').style.transform = `rotate(${heading}deg)`;
  }
}

function nearestUnheard() {
  if (!pos) return null;
  return places.filter((p) => nextScene(p)).sort((a, b) => a.dist - b.dist)[0] || null;
}

function renderMap() {
  for (const p of places) {
    const left = p.scenes.filter((s) => !played.has(s.id)).length;
    const cls = [left ? '' : 'done', inRange(p) ? 'near' : '', current?.place === p ? 'now' : ''].join(' ');
    const key = `${cls}|${left}`;
    const m = markers.get(p.id);
    if (m.key === key) continue;
    m.key = key;
    m.marker.setIcon(L.divIcon({
      className: '', iconSize: [28, 28], iconAnchor: [14, 14],
      html: `<div class="pin ${cls}"><i>${left || '✓'}</i><span>${esc(p.nameZh)}</span></div>`,
    }));
  }
  renderMe();

  const target = nearestUnheard();
  if (targetLine) { targetLine.remove(); targetLine = null; }
  if (target && !routeLine) {
    targetLine = L.polyline([[pos.lat, pos.lng], [target.lat, target.lng]], { color: '#2f7de1', weight: 2, dashArray: '6 8', interactive: false }).addTo(map);
  }
  const banner = $('nextBanner');
  banner.hidden = !target;
  if (target) {
    banner.dataset.id = target.id;
    banner.textContent = inRange(target)
      ? `你在这里：${target.nameZh} ›`
      : `最近：${target.nameZh} · ${fmtDist(target.dist)} · ${bearingLabel(pos.lat, pos.lng, target.lat, target.lng)} ›`;
  }
}

async function showRoute(place) {
  clearRoute();
  radiusCircle = L.circle([place.lat, place.lng], { radius: place.radiusM, color: '#8c3b2a', weight: 1, fillOpacity: 0.12, interactive: false }).addTo(map);
  setFollow(false);
  if (!pos) { map.setView([place.lat, place.lng], 17); return; }
  let latlngs = [[pos.lat, pos.lng], [place.lat, place.lng]];
  let info = `直线 ${fmtDist(place.dist)}（暂时取不到步行路线）`;
  try {
    const res = await fetch(`${ROUTER}${pos.lng},${pos.lat};${place.lng},${place.lat}?overview=full&geometries=geojson`);
    const route = (await res.json()).routes[0];
    latlngs = route.geometry.coordinates.map(([lng, lat]) => [lat, lng]);
    info = `步行约 ${fmtDist(route.distance)} · ${Math.max(1, Math.round(route.distance / 75))} 分钟`;
  } catch { /* offline: keep the straight line */ }
  routeLine = L.polyline(latlngs, { color: '#2f7de1', weight: 5, opacity: 0.75, interactive: false }).addTo(map);
  map.fitBounds(routeLine.getBounds().pad(0.15));
  $('status').textContent = `去 ${place.nameZh}：${info}（点这里清除路线）`;
  render();
}

function clearRoute() {
  routeLine?.remove(); routeLine = null;
  radiusCircle?.remove(); radiusCircle = null;
}

// ---------- list & detail ----------

function renderList() {
  const sorted = [...places].sort((a, b) => (a.dist ?? 0) - (b.dist ?? 0));
  $('places').innerHTML = sorted.map((p) => {
    const left = p.scenes.filter((s) => !played.has(s.id)).length;
    const dist = p.dist == null ? '' : `${fmtDist(p.dist)}<small>${bearingLabel(pos.lat, pos.lng, p.lat, p.lng)}</small>`;
    const chapters = [...new Set(p.scenes.map((s) => s.chapterLabel))].join('、');
    return `<li data-id="${p.id}" class="${inRange(p) ? 'near' : ''}">
      <div><div class="name">${esc(p.nameZh)}<span class="badge ${p.confidence}">${p.confidence}</span></div>
      <div class="sub">${esc(p.canonicalName)} · ${p.scenes.length} 段（${chapters}）${left ? '' : ' · 已听完'}</div></div>
      <div class="dist">${dist}</div></li>`;
  }).join('');
}

function render() { renderMap(); renderList(); }

const STATUS = {
  extant: '原址仍在', renamed: '原址仍在，已改名', closed: '已停业', 'closed-1941': '1941 年停业，现非书店',
  demolished: '原建筑已拆除', rebuilt: '已重建', 'unidentified-café': '具体店家无法确认',
  'extant-collection-moved': '建筑仍在，藏品已迁走',
};

function openDetail(place) {
  const d = $('detail');
  const dest = `${place.lat},${place.lng}`;
  d.innerHTML = `
    <h3>${esc(place.nameZh)} <span class="badge ${place.confidence}">${place.confidence}</span></h3>
    <div class="latin">${esc(place.canonicalName)}${place.dist != null ? ` · 距你 ${fmtDist(place.dist)}` : ''}</div>
    <dl class="facts">
      <dt>当年</dt><dd>${esc(place.historicalName)}<br>${esc(place.historicalAddress)}</dd>
      <dt>今天</dt><dd>${esc(place.modernName)}<br>${esc(place.modernAddress)}</dd>
      <dt>现状</dt><dd>${esc(STATUS[place.status] || place.status)}</dd>
    </dl>
    <p class="note">${esc(place.note)}</p>
    <div class="row">
      <button data-route>在地图上看步行路线</button>
      <a href="https://maps.apple.com/?daddr=${dest}&dirflg=w" target="_blank" rel="noopener">苹果地图导航</a>
      <a href="https://www.google.com/maps/dir/?api=1&destination=${dest}&travelmode=walking" target="_blank" rel="noopener">Google 地图导航</a>
    </div>
    ${place.scenes.map((s, i) => `
      <div class="scene">
        <div class="row between"><strong>${esc(s.title)}</strong>
          <button data-scene="${i}">▶ ${fmtDur((s.durationSec || 0) + (s.introDurationSec || 0)) || '播放'}</button></div>
        ${sceneHtml(s)}
        ${s.englishAnchorStart ? `<div class="anchor">英文原文起句：“${esc(s.englishAnchorStart)}…”</div>` : ''}
        ${played.has(s.id) ? '<div class="sub">已听过</div>' : ''}
        ${s.needsReview ? '<div class="review">待核对：这一段来自附录，英文锚点未经公开文本验证，不会自动播放</div>' : ''}
      </div>`).join('')}
    <details class="evidence"><summary>地点考证依据（${place.evidence.length}）</summary><ul>
      ${place.evidence.map((e) => `<li><a href="${esc(e.url)}" target="_blank" rel="noopener">${esc(e.source)}</a><br>${esc(e.claim)}</li>`).join('')}
    </ul></details>
    <div class="row between"><button data-close>关闭</button><button class="link" data-sim>模拟到达这里</button></div>`;
  d.onclick = (ev) => {
    const t = ev.target;
    if (t === d || t.dataset.close !== undefined) d.close();
    else if (t.dataset.scene !== undefined) { d.close(); start(); play(place, place.scenes[+t.dataset.scene]); }
    else if (t.dataset.route !== undefined) { d.close(); showRoute(place); }
    else if (t.dataset.sim !== undefined) {
      d.close(); start(); setFollow(true);
      onPosition({ lat: place.lat, lng: place.lng, accuracy: 5, simulated: true });
    }
  };
  d.showModal();
  d.scrollTop = 0;
}

// ---------- offline ----------

async function cacheAll() {
  if (!('caches' in window)) { $('cacheStatus').textContent = '此浏览器不支持离线缓存'; return; }
  const urls = places.flatMap((p) => p.scenes.flatMap((s) => [s.introAudio, s.audio]));
  const cache = await caches.open('feast-audio-v3');
  let done = 0, failed = 0;
  for (const url of urls) {
    try {
      if (!(await cache.match(url))) {
        const res = await fetch(url);
        if (!res.ok) throw new Error(res.status);
        await cache.put(url, res);
      }
    } catch { failed++; }
    $('cacheStatus').textContent = `${++done}/${urls.length}`;
  }
  $('cacheStatus').textContent = failed ? `完成，${failed} 个失败` : '全部音频已可离线播放';
}

// ---------- wiring ----------

async function init() {
  const [data, metro] = await Promise.all([
    fetch('data/places.json').then((r) => r.json()),
    fetch('data/metro.json').then((r) => r.json()).catch(() => []),
  ]);
  places = data.places;
  people = data.people;
  $('autoToggle').checked = store.get('auto', true);
  $('introToggle').checked = store.get('intro', true);
  initMap(metro);
  render();

  $('startBtn').onclick = start;
  $('stopBtn').onclick = () => stop();
  $('skipBtn').onclick = () => { if (current?.phase === 'intro') setPhase('main'); };
  $('textBtn').onclick = () => { $('sceneText').hidden = !$('sceneText').hidden; };
  $('cacheBtn').onclick = cacheAll;
  $('resetBtn').onclick = () => { played = new Set(); store.set('played', []); render(); };
  $('status').onclick = () => {
    if (routeLine) { clearRoute(); $('status').textContent = ''; render(); }
    if (pos?.simulated) { pos = null; $('status').textContent = '正在获取定位…'; watch(); }
  };
  $('autoToggle').onchange = () => { store.set('auto', $('autoToggle').checked); maybeAutoplay(); };
  $('introToggle').onchange = () => store.set('intro', $('introToggle').checked);
  $('fullBtn').onclick = () => {
    const full = $('mapWrap').classList.toggle('full');
    $('fullBtn').textContent = full ? '✕' : '⤢';
    // Wait for the new layout before telling Leaflet, or it keeps the old tile area.
    requestAnimationFrame(() => map.invalidateSize());
  };
  $('locateBtn').onclick = () => {
    if (!started) { start(); return; }
    setFollow(true);
    if (pos) map.setView([pos.lat, pos.lng], Math.max(map.getZoom(), 17));
    if (!pos?.simulated) watch();            // restart the watch: nudges a stuck GPS
  };
  $('fitBtn').onclick = () => { setFollow(false); fitAll(); };
  audio.addEventListener('ended', () => { if (current) onEnded(); });
  audio.addEventListener('error', () => { if (current) speak(); });

  const byId = (id) => places.find((p) => p.id === id);
  $('places').onclick = (ev) => { const li = ev.target.closest('li'); if (li) openDetail(byId(li.dataset.id)); };
  $('nextBanner').onclick = () => openDetail(byId($('nextBanner').dataset.id));
  document.addEventListener('visibilitychange', () => {
    if (!started || document.visibilityState !== 'visible') return;
    keepAwake();
    if (!pos?.simulated) watch();            // iOS drops the watch while the page is hidden
  });

  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
}

init();
