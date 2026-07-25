'use strict';

const AI = '#165e83';
const $ = (id) => document.getElementById(id);

const state = {
  map: null,
  routeLine: null,
  clickMarker: null,
  posMarker: null,
  route: [],   // 密度化した経路点 [{lat,lng}]
  segs: [],    // ルート区間 [{a,b,cls,lit,level}](夜の明るさ推定つき)
  pois: [],    // 周辺のコンビニ・駅 [{lat,lng,type}]
  night: false,
  nightLayer: null,
  panos: [],   // [{id, lat, lng, heading}]
  idx: 0,
  playing: false,
  timer: null,
  raf: null,
  panorama: null,
  prefetchPano: null,
  svService: null,
  gmapsPromise: null,
  lastTileAt: 0,
};

init();

function init() {
  ingestSharedKey();
  const map = L.map('map', { zoomControl: false }).setView([36.0839, 140.0764], 15);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; OpenStreetMap contributors',
  }).addTo(map);
  L.control.zoom({ position: 'bottomleft' }).addTo(map);
  state.map = map;

  map.on('click', (e) => makeRoute(e.latlng));
  $('addr').addEventListener('keydown', (e) => { if (e.key === 'Enter') searchAddr(); });
  $('addr').addEventListener('search', searchAddr); // type=search のEnter/クリア対応の保険
  $('walkBtn').onclick = startWalk;
  $('playBtn').onclick = () => setPlaying(!state.playing);
  $('exitBtn').onclick = exitWalk;
  $('seek').oninput = (e) => jumpTo(+e.target.value);
  $('keyBtn').onclick = () => showKeyModal(true);
  $('nightBtn').onclick = () => {
    state.night = !state.night;
    $('nightBtn').classList.toggle('primary', state.night);
    drawRoute();
    applyNightFx(state.panos[state.idx]?.level);
    if (state.night) {
      const c = state.lampCity;
      const basis = c ? `${c.name}の街灯${c.n.toLocaleString()}灯の実データ` : '推定';
      setStatus(document.body.classList.contains('walk')
        ? `夜シミュレーション中(${basis})。暗そうな区間ほど画面が暗くなります`
        : `夜の明るさ(${basis}): 黄=明るそう・灰青=ふつう・紺=暗そう。歩くと画面の暗さも連動します`);
    }
  };
  $('keySave').onclick = saveKey;
  $('keyCancel').onclick = () => showKeyModal(false);

  window.gm_authFailure = () => {
    setStatus('APIキーが無効のようです。Maps JavaScript API の有効化と課金設定を確認してください');
    exitWalk();
    showKeyModal(true);
  };

  // ストリートビューのタイル取得を監視。取得が止まった=表示中(と先読み)の読み込み完了とみなす
  try {
    performance.setResourceTimingBufferSize(20000);
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        if (e.name.includes('streetviewpixels') || e.name.includes('/cbk')) {
          state.lastTileAt = performance.now();
        }
      }
    }).observe({ type: 'resource' });
  } catch (e) { /* 非対応ブラウザでは待ち時間だけで進む */ }
}

function setStatus(msg) { $('status').textContent = msg; }

// 共有リンク (…/#key=XXXX) で鍵を受け取ったら保存し、URL欄からは即消す。
// フラグメント(#以降)はサーバーに送られないので、クエリ(?key=)より漏れにくい。
function ingestSharedKey() {
  const m = location.hash.match(/(?:^#|&)key=([^&]+)/);
  if (!m) return;
  localStorage.setItem('gururi_key', decodeURIComponent(m[1]));
  history.replaceState(null, '', location.pathname + location.search);
}

// ---------- 住所検索 ----------

async function searchAddr() {
  const q = $('addr').value.trim();
  if (!q) return;
  if (document.body.classList.contains('walk')) exitWalk();
  setStatus('住所を検索中…');
  try {
    const url = 'https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&countrycodes=jp&accept-language=ja&q=' + encodeURIComponent(q);
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
    const list = await res.json();
    if (!list.length) {
      setStatus('見つかりませんでした。「市区町村から」など表記を変えて試してください');
      return;
    }
    const r = list[0];
    const ll = L.latLng(+r.lat, +r.lon);
    state.map.setView(ll, 16);
    makeRoute(ll);
  } catch (e) {
    setStatus('検索に失敗しました。少し待って再試行してください');
  }
}

// ---------- ルート生成 ----------

async function makeRoute(ll) {
  if (document.body.classList.contains('walk')) return;
  stopAll();
  clearRoute();
  setStatus('道路データを取得中…');
  state.clickMarker = L.circleMarker(ll, { radius: 6, color: AI, fillColor: AI, fillOpacity: 1 }).addTo(state.map);

  const R = +$('radius').value;
  let elements;
  try {
    elements = await fetchRoads(ll, R);
  } catch (e) {
    setStatus('道路データの取得に失敗しました。少し時間をおいて再クリックしてください');
    return;
  }

  const g = buildGraph(elements);
  const loop = makeLoop(g, ll, R);
  if (!loop || loop.length < 2) {
    setStatus('この場所ではルートを作れませんでした。道路の多い場所を試してください');
    return;
  }

  // 夜の明るさ推定の材料: 周辺のコンビニ・駅
  state.pois = elements
    .filter((el) => el.type === 'node' && el.tags)
    .map((el) => ({
      lat: el.lat, lng: el.lon,
      type: el.tags.shop === 'convenience' ? 'conbini' : 'station',
    }));

  // 街灯データを公開している自治体なら実データ、それ以外は推定にフォールバック
  state.lampCity = null;
  const city = lampCityFor(ll);
  if (city) {
    try {
      setStatus(`${city.name}の街灯オープンデータを読み込み中…`);
      await loadLamps(city);
      state.lampCity = city;
    } catch (e) { /* 取得できなければ推定のまま */ }
  }

  // ルートを区間に分け、区間ごとに夜の明るさを判定
  state.segs = [];
  for (let i = 1; i < loop.length; i++) {
    const a = g.pos.get(loop[i - 1]);
    const b = g.pos.get(loop[i]);
    const e = (g.adj.get(loop[i - 1]) || []).find((x) => x.to === loop[i]);
    const seg = { a, b, cls: e?.cls, lit: e?.lit };
    seg.level = state.lampCity ? nightLevelReal(seg, state.lampCity) : nightLevel(seg);
    state.segs.push(seg);
  }

  const pts = loop.map((id) => g.pos.get(id));
  state.route = densify(pts, 13);
  drawRoute();
  state.map.fitBounds(L.latLngBounds(pts), { padding: [40, 40] });

  const dist = Math.round(pathLength(pts));
  const lampNote = state.lampCity ? `(${state.lampCity.name}は街灯の実データ対応)` : '';
  if (dist < R * 1.5) {
    setStatus(`約${dist}mと短めのルートです。場所を少しずらすか、半径を上げると良いかも${lampNote}`);
  } else {
    setStatus(`約${dist}mの一周ルートができました${lampNote}`);
  }
  $('walkBtn').hidden = false;
}

async function fetchRoads(ll, r) {
  const types = 'trunk|primary|secondary|tertiary|unclassified|residential|living_street|pedestrian';
  // 道路に加えて、夜の明るさ推定の材料(コンビニ・駅)も1リクエストでまとめて取る
  const q = `[out:json][timeout:20];(` +
    `way(around:${r},${ll.lat},${ll.lng})[highway~"^(${types})$"][area!=yes];` +
    `node(around:${r + 150},${ll.lat},${ll.lng})[shop=convenience];` +
    `node(around:${r + 300},${ll.lat},${ll.lng})[railway=station];` +
    `);out geom;`;
  const endpoints = [
    'https://overpass-api.de/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter',
    'https://overpass.private.coffee/api/interpreter',
    'https://overpass.openstreetmap.fr/api/interpreter',
  ];
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) {
      setStatus(`道路データのサーバーが混み合っています。自動で再試行中…(${attempt}/2)`);
      await new Promise((ok) => setTimeout(ok, 4000));
    }
    for (const ep of endpoints) {
      try {
        const res = await fetch(ep, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: 'data=' + encodeURIComponent(q),
          signal: AbortSignal.timeout(12000), // 応答しないサーバーは打ち切って次のミラーへ
        });
        if (!res.ok) continue;
        return (await res.json()).elements;
      } catch (e) { /* 次のミラーへ */ }
    }
  }
  throw new Error('overpass failed');
}

function buildGraph(elements) {
  const pos = new Map();
  const adj = new Map();
  const addEdge = (a, b, w, cls, lit) => {
    if (!adj.has(a)) adj.set(a, []);
    adj.get(a).push({ to: b, w, cls, lit });
  };
  for (const el of elements) {
    if (el.type !== 'way' || !el.geometry || !el.nodes) continue;
    const cls = el.tags?.highway;
    const lit = el.tags?.lit;
    for (let i = 0; i < el.nodes.length; i++) {
      const gpt = el.geometry[i];
      if (gpt) pos.set(el.nodes[i], { lat: gpt.lat, lng: gpt.lon });
    }
    for (let i = 1; i < el.nodes.length; i++) {
      const a = el.nodes[i - 1], b = el.nodes[i];
      const pa = pos.get(a), pb = pos.get(b);
      if (!pa || !pb) continue;
      const w = hav(pa, pb);
      addEdge(a, b, w, cls, lit);
      addEdge(b, a, w, cls, lit);
    }
  }
  return { pos, adj };
}

// クリック地点の最寄りノードから、周囲4方向の経由点を最短路でつないで一周する。
// 使った道は重みを上げ、行きと帰りが同じ道になりにくくする。
function makeLoop(g, ll, R) {
  const start = nearestNode(g, ll, null);
  if (start == null) return null;
  const reachable = bfs(g, start);

  const wps = [];
  for (const ang of [0, 60, 120, 180, 240, 300]) {
    const target = offset(ll, R * 0.72, ang);
    const n = nearestNode(g, target, reachable);
    if (n != null && n !== start && !wps.includes(n)) wps.push(n);
  }
  if (wps.length === 0) return null;

  const seq = [start, ...wps, start];
  const penalties = new Map();
  const full = [seq[0]];
  for (let i = 1; i < seq.length; i++) {
    const leg = dijkstra(g, seq[i - 1], seq[i], penalties);
    if (!leg) continue;
    for (let j = 1; j < leg.length; j++) {
      full.push(leg[j]);
      const key = edgeKey(leg[j - 1], leg[j]);
      penalties.set(key, (penalties.get(key) || 1) * 4);
    }
  }
  // 行き止まりへ入って戻るだけの「ヒゲ」(a-b-a)を刈り、素直な一周にする
  const pruned = [];
  for (const n of full) {
    if (pruned.length >= 2 && pruned[pruned.length - 2] === n) pruned.pop();
    else pruned.push(n);
  }
  return pruned.length >= 2 ? pruned : null;
}

function edgeKey(a, b) { return a < b ? `${a}_${b}` : `${b}_${a}`; }

// ---------- 夜の明るさ推定 ----------

function segMid(seg) {
  return { lat: (seg.a.lat + seg.b.lat) / 2, lng: (seg.a.lng + seg.b.lng) / 2 };
}

// 夜も灯りと人がある場所(コンビニ・駅)の近さによる加点
function poiBonus(mid) {
  let dC = Infinity, dS = Infinity;
  for (const p of state.pois) {
    const d = hav(mid, p);
    if (p.type === 'conbini') dC = Math.min(dC, d);
    else dS = Math.min(dS, d);
  }
  let s = 0;
  if (dC < 60) s += 3; else if (dC < 120) s += 2; else if (dC < 180) s += 1;
  if (dS < 150) s += 2; else if (dS < 300) s += 1;
  return s;
}

const toLevel = (s) => (s >= 4 ? 'bright' : s >= 2 ? 'mid' : 'dark');

// 推定版(街灯データが無い地域用)。根拠: 幹線道路は街灯整備がほぼ確実 / litタグ / コンビニ・駅。
// 夜の映像は存在しないので、映像を加工せずデータで答える方針([[NOTES-local.md]]参照)
function nightLevel(seg) {
  const mid = segMid(seg);
  let s = { trunk: 4, primary: 4, secondary: 3, tertiary: 2, pedestrian: 1.5 }[seg.cls] ?? 1;
  if (seg.lit === 'yes') s += 2;
  else if (seg.lit === 'no') s -= 2;
  return toLevel(s + poiBonus(mid));
}

// 実データ版(街灯を公開している自治体)。中点30m以内の実際の街灯本数で判定する。
// 注意: 幹線道路の照明は都道府県・国の管理で市の台帳に載らない(町田市データでは
// primary の58%が街灯0本だった)。そのため幹線は0本でも「暗い」と断定しない。
function nightLevelReal(seg, city) {
  const mid = segMid(seg);
  const n = lampsNear(city, mid, 30);
  seg.lamps = n;
  let s = n >= 4 ? 5 : n >= 2 ? 4 : n === 1 ? 2.5 : 0.5;
  if (['trunk', 'primary', 'secondary'].includes(seg.cls)) s = Math.max(s, 2.5);
  if (seg.lit === 'yes') s = Math.max(s, 4);
  else if (seg.lit === 'no') s = Math.min(s, 1);
  return toLevel(s + poiBonus(mid));
}

// ---------- 街灯オープンデータ(対応自治体のみ) ----------
// 位置つきの街灯データを公開している自治体はごく少ない(東京都カタログの「街路灯」30件中、
// 実際の位置データは町田市のみ。他は設置数の統計)。対応都市は実データ、他は推定に自動で切替。
const LAMP_CITIES = [
  {
    name: '町田市',
    file: 'lamps/machida.json',
    bbox: [35.4962, 139.2760, 35.6264, 139.5105], // [南, 西, 北, 東]
    source: '町田市オープンデータ「街路灯」CC BY 4.0',
  },
];

const LAMP_CELL = 2000; // 約50m格子

function lampCityFor(ll) {
  return LAMP_CITIES.find((c) =>
    ll.lat >= c.bbox[0] && ll.lat <= c.bbox[2] && ll.lng >= c.bbox[1] && ll.lng <= c.bbox[3]);
}

async function loadLamps(city) {
  if (city.grid) return city;
  const res = await fetch(city.file, { signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error('lamp data ' + res.status);
  const d = await res.json();
  const dlat = d.dlat.split(',');
  const dlng = d.dlng.split(',');
  const grid = new Map();
  let la = d.lat0;
  for (let i = 0; i < dlat.length; i++) {
    la += +dlat[i];
    const p = { lat: la / 1e5, lng: (d.lng0 + +dlng[i]) / 1e5 };
    const k = Math.floor(p.lat * LAMP_CELL) + ':' + Math.floor(p.lng * LAMP_CELL);
    const arr = grid.get(k);
    if (arr) arr.push(p); else grid.set(k, [p]);
  }
  city.grid = grid;
  city.n = d.n;
  return city;
}

function lampsNear(city, p, radius) {
  const r = Math.floor(p.lat * LAMP_CELL), c = Math.floor(p.lng * LAMP_CELL);
  let n = 0;
  for (let i = -1; i <= 1; i++) {
    for (let j = -1; j <= 1; j++) {
      const arr = city.grid.get((r + i) + ':' + (c + j));
      if (!arr) continue;
      for (const q of arr) if (hav(p, q) <= radius) n++;
    }
  }
  return n;
}

const NIGHT_COLORS = { bright: '#e6a817', mid: '#8fa3b8', dark: '#243b6b' };

// 夜シミュレーション: 歩行中、区間の推定に連動して画面の暗さを変える(本物の夜景ではない)
const NIGHT_FX = {
  bright: { filter: 'brightness(0.85) saturate(0.9)', veil: 0.12 },
  mid:    { filter: 'brightness(0.6) saturate(0.75)', veil: 0.28 },
  dark:   { filter: 'brightness(0.35) saturate(0.55)', veil: 0.45 },
};

function applyNightFx(level) {
  const fx = state.night && level ? NIGHT_FX[level] : null;
  $('pano').style.filter = fx ? fx.filter : '';
  $('nightVeil').style.opacity = fx ? fx.veil : 0;
}

// パノラマ地点に一番近いルート区間の明るさ推定を引く
function nearestSegLevel(p) {
  let best = 'mid', bd = Infinity;
  for (const s of state.segs) {
    const m = { lat: (s.a.lat + s.b.lat) / 2, lng: (s.a.lng + s.b.lng) / 2 };
    const d = hav(p, m);
    if (d < bd) { bd = d; best = s.level; }
  }
  return best;
}

// ルート描画。通常は藍の一本線、夜の明るさONなら区間色分け+コンビニの黄点
function drawRoute() {
  if (state.routeLine) { state.routeLine.remove(); state.routeLine = null; }
  if (state.nightLayer) { state.nightLayer.remove(); state.nightLayer = null; }
  if (!state.segs.length) return;
  if (state.night) {
    const grp = L.layerGroup();
    for (const seg of state.segs) {
      L.polyline([seg.a, seg.b], { color: NIGHT_COLORS[seg.level], weight: 5, opacity: 0.95 }).addTo(grp);
    }
    for (const p of state.pois) {
      if (p.type !== 'conbini') continue;
      L.circleMarker(p, { radius: 4, color: '#fff', weight: 1, fillColor: NIGHT_COLORS.bright, fillOpacity: 1 }).addTo(grp);
    }
    state.nightLayer = grp.addTo(state.map);
  } else {
    const pts = state.segs.map((s) => s.a).concat([state.segs[state.segs.length - 1].b]);
    state.routeLine = L.polyline(pts, { color: AI, weight: 4, opacity: 0.9 }).addTo(state.map);
  }
}

function nearestNode(g, ll, filterSet) {
  let best = null, bestD = Infinity;
  for (const [id, p] of g.pos) {
    if (filterSet && !filterSet.has(id)) continue;
    if (!g.adj.has(id)) continue;
    const d = hav(ll, p);
    if (d < bestD) { bestD = d; best = id; }
  }
  return best;
}

function bfs(g, start) {
  const seen = new Set([start]);
  const queue = [start];
  while (queue.length) {
    const n = queue.shift();
    for (const e of g.adj.get(n) || []) {
      if (!seen.has(e.to)) { seen.add(e.to); queue.push(e.to); }
    }
  }
  return seen;
}

function dijkstra(g, from, to, penalties) {
  const dist = new Map([[from, 0]]);
  const prev = new Map();
  const done = new Set();
  while (true) {
    let cur = null, curD = Infinity;
    for (const [n, d] of dist) {
      if (!done.has(n) && d < curD) { curD = d; cur = n; }
    }
    if (cur == null) return null;
    if (cur === to) break;
    done.add(cur);
    for (const e of g.adj.get(cur) || []) {
      const w = e.w * (penalties.get(edgeKey(cur, e.to)) || 1);
      const nd = curD + w;
      if (nd < (dist.get(e.to) ?? Infinity)) {
        dist.set(e.to, nd);
        prev.set(e.to, cur);
      }
    }
  }
  const path = [to];
  while (path[0] !== from) path.unshift(prev.get(path[0]));
  return path;
}

// ---------- 幾何ユーティリティ ----------

function hav(a, b) {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLng = (b.lng - a.lng) * rad;
  const s = Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 6371000 * 2 * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s));
}

function bearing(a, b) {
  const rad = Math.PI / 180;
  const y = Math.sin((b.lng - a.lng) * rad) * Math.cos(b.lat * rad);
  const x = Math.cos(a.lat * rad) * Math.sin(b.lat * rad) -
    Math.sin(a.lat * rad) * Math.cos(b.lat * rad) * Math.cos((b.lng - a.lng) * rad);
  return (Math.atan2(y, x) / rad + 360) % 360;
}

function offset(ll, d, angDeg) {
  const r = angDeg * Math.PI / 180;
  return {
    lat: ll.lat + (d * Math.cos(r)) / 111320,
    lng: ll.lng + (d * Math.sin(r)) / (111320 * Math.cos(ll.lat * Math.PI / 180)),
  };
}

function densify(pts, step) {
  const out = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    const d = hav(a, b);
    const n = Math.max(1, Math.round(d / step));
    for (let k = 1; k <= n; k++) {
      out.push({ lat: a.lat + (b.lat - a.lat) * k / n, lng: a.lng + (b.lng - a.lng) * k / n });
    }
  }
  return out;
}

function pathLength(pts) {
  let d = 0;
  for (let i = 1; i < pts.length; i++) d += hav(pts[i - 1], pts[i]);
  return d;
}

// ---------- ストリートビュー再生 ----------

// 保存済みの鍵 → config.js の同梱鍵 の順に使う(config.js が無くても手入力で動く)
function getKey() {
  return localStorage.getItem('gururi_key') || window.GURURI_KEY || '';
}

async function startWalk() {
  if (!state.route.length) return; // ルート生成前に呼ばれた場合の保険
  const key = getKey();
  if (!key) { showKeyModal(true); return; }
  setStatus('Google Maps を読み込み中…');
  try {
    await loadGmaps(key);
  } catch (e) {
    setStatus('Google Maps の読み込みに失敗しました。APIキーを確認してください');
    showKeyModal(true);
    return;
  }
  enterWalkMode();
  await preparePanos();
  if (state.panos.length < 2) {
    setStatus('この道路のストリートビューが見つかりませんでした。別の場所を試してください');
    exitWalk();
    return;
  }
  $('seek').max = state.panos.length - 1;
  setStatus(`一周 ${state.panos.length} 地点`);
  jumpTo(0);
  setPlaying(true);
}

function loadGmaps(key) {
  if (window.google && window.google.maps) return Promise.resolve();
  if (state.gmapsPromise) return state.gmapsPromise;
  state.gmapsPromise = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(key)}&v=weekly&language=ja&callback=__gururiGmaps`;
    window.__gururiGmaps = resolve;
    s.onerror = () => { state.gmapsPromise = null; reject(new Error('gmaps load error')); };
    document.head.appendChild(s);
  });
  return state.gmapsPromise;
}

async function preparePanos() {
  state.svService = state.svService || new google.maps.StreetViewService();
  const results = new Array(state.route.length).fill(null);
  let next = 0;
  const POOL = 8;
  const worker = async () => {
    while (next < state.route.length) {
      const i = next++;
      setStatus(`ストリートビューを探索中… ${i + 1}/${state.route.length}`);
      results[i] = await svLookup(state.route[i]).catch(() => null);
    }
  };
  await Promise.all(Array.from({ length: POOL }, worker));

  const out = [];
  for (const r of results) {
    if (r && (!out.length || out[out.length - 1].id !== r.id)) out.push(r);
  }
  for (let i = 0; i < out.length; i++) {
    out[i].heading = i < out.length - 1
      ? bearing(out[i], out[i + 1])
      : (out[i - 1]?.heading ?? 0);
    out[i].level = nearestSegLevel(out[i]);
  }
  state.panos = out;
}

function svLookup(p) {
  return new Promise((resolve, reject) => {
    state.svService.getPanorama({
      location: { lat: p.lat, lng: p.lng },
      radius: 26,
      source: google.maps.StreetViewSource.OUTDOOR,
      preference: google.maps.StreetViewPreference.NEAREST,
    }, (data, status) => {
      if (status === 'OK' && data && data.location) {
        resolve({
          id: data.location.pano,
          lat: data.location.latLng.lat(),
          lng: data.location.latLng.lng(),
        });
      } else {
        reject(status);
      }
    });
  });
}

function enterWalkMode() {
  document.body.classList.add('walk');
  $('walkBtn').hidden = true;
  $('controls').hidden = false;
  state.map.invalidateSize();
  if (!state.panorama) {
    const opts = {
      disableDefaultUI: true,
      clickToGo: false,
      showRoadLabels: false,
      motionTracking: false,
      motionTrackingControl: false,
    };
    state.panorama = new google.maps.StreetViewPanorama($('pano'), opts);
    // 次のパノラマを不可視ビューアで先に読み込み、切替時の読み込み待ちを減らす
    state.prefetchPano = new google.maps.StreetViewPanorama($('prefetch'), opts);
  }
  if (!state.posMarker) {
    state.posMarker = L.circleMarker(state.route[0], { radius: 5, color: '#fff', weight: 2, fillColor: AI, fillOpacity: 1 });
  } else {
    state.posMarker.setLatLng(state.route[0]); // 前回ルートの位置を引きずらない
  }
  state.posMarker.addTo(state.map);
}

function exitWalk() {
  stopAll();
  applyNightFx(null);
  document.body.classList.remove('walk');
  $('controls').hidden = true;
  if (state.routeLine) {
    $('walkBtn').hidden = false;
    setStatus('地図に戻りました。もう一度歩くか、別の場所をクリックしてください');
  }
  if (state.posMarker) state.posMarker.remove();
  state.map.invalidateSize();
}

function jumpTo(i) {
  if (!state.panos.length) return;
  state.idx = Math.max(0, Math.min(i, state.panos.length - 1));
  const p = state.panos[state.idx];
  state.panorama.setPano(p.id);
  applyNightFx(p.level);
  if (kyoroNow()) animateSweep(p.heading);
  else if (gazeMode() === 'nagara') animateHeading(p.heading + nagaraOffset(state.idx));
  else animateHeading(p.heading);
  performance.clearResourceTimings(); // 計測バッファが詰まるとタイル検知が止まるため毎歩クリア
  $('seek').value = state.idx;
  if (state.posMarker) state.posMarker.setLatLng(p);
  const next = state.panos[state.idx + 1];
  if (next && state.prefetchPano) {
    state.prefetchPano.setPano(next.id);
    state.prefetchPano.setPov({ heading: next.heading, pitch: 0 });
  }
}

// キョロキョロは酔い対策で3地点に1回だけ。間の2歩は前を向いて歩く
const KYORO_EVERY = 3;

function gazeMode() { return $('gazeMode').value; }

function kyoroNow() {
  return gazeMode() === 'kyoro' && state.idx % KYORO_EVERY === 0;
}

// ながら見: 視線を進行方向±45°の範囲で、9歩周期でゆっくり左右に漂わせる
function nagaraOffset(i) {
  return 45 * Math.sin((i * 2 * Math.PI) / 9);
}

// キョロキョロ1回分の所要時間。速度設定(=眺める時間)に連動
function kyoroDur() {
  return 2000 + (+$('speed').value);
}

// 立ち止まって見回す: 進行方向へ向き直し → 左80° → 右80° → 正面
function animateSweep(center) {
  cancelAnimationFrame(state.raf);
  const pano = state.panorama;
  const from = pano.getPov().heading || 0;
  const d0 = ((center - from + 540) % 360) - 180;
  const t0 = performance.now();
  const dur = kyoroDur();
  const A = 60;
  const ss = (k) => k * k * (3 - 2 * k); // smoothstep
  const step = (t) => {
    const k = Math.min(1, (t - t0) / dur);
    let h;
    if (k < 0.15) h = from + d0 * ss(k / 0.15);
    else if (k < 0.45) h = center - A * ss((k - 0.15) / 0.3);
    else if (k < 0.85) h = center - A + 2 * A * ss((k - 0.45) / 0.4);
    else h = center + A * (1 - ss((k - 0.85) / 0.15));
    pano.setPov({ heading: h, pitch: 0 });
    if (k < 1) state.raf = requestAnimationFrame(step);
  };
  state.raf = requestAnimationFrame(step);
}

function animateHeading(target) {
  cancelAnimationFrame(state.raf);
  const pano = state.panorama;
  const from = pano.getPov().heading || 0;
  const delta = ((target - from + 540) % 360) - 180;
  const t0 = performance.now();
  const dur = 450;
  const step = (t) => {
    const k = Math.min(1, (t - t0) / dur);
    const e = k * (2 - k);
    pano.setPov({ heading: from + delta * e, pitch: 0 });
    if (k < 1) state.raf = requestAnimationFrame(step);
  };
  state.raf = requestAnimationFrame(step);
}

function setPlaying(p) {
  state.playing = p;
  $('playBtn').textContent = p ? '⏸' : '▶';
  clearTimeout(state.timer);
  if (p) tick();
}

// 速度設定は「読み込み完了後にその場を眺める時間」。タイル取得が続いている間は進まない
function tick() {
  if (!state.playing) return;
  // 見回し中の地点だけ、見回しが終わるまで進まない
  const dwell = kyoroNow() ? kyoroDur() : +$('speed').value;
  const started = performance.now();
  const check = () => {
    if (!state.playing) return;
    const now = performance.now();
    const loading = now - state.lastTileAt < 350;
    const waited = now - started;
    if ((!loading && waited >= dwell) || waited >= dwell + 6000) {
      if (state.idx >= state.panos.length - 1) {
        setPlaying(false);
        setStatus('一周して出発地点に戻りました');
        return;
      }
      jumpTo(state.idx + 1);
      tick();
    } else {
      state.timer = setTimeout(check, 150);
    }
  };
  state.timer = setTimeout(check, dwell);
}

function stopAll() {
  state.playing = false;
  clearTimeout(state.timer);
  cancelAnimationFrame(state.raf);
  $('playBtn').textContent = '⏸';
}

function clearRoute() {
  if (state.routeLine) { state.routeLine.remove(); state.routeLine = null; }
  if (state.nightLayer) { state.nightLayer.remove(); state.nightLayer = null; }
  if (state.clickMarker) { state.clickMarker.remove(); state.clickMarker = null; }
  state.route = [];
  state.segs = [];
  state.pois = [];
  state.panos = [];
  state.idx = 0;
  $('walkBtn').hidden = true;
  $('controls').hidden = true;
  $('seek').value = 0;
  $('seek').max = 0;
}

// ---------- APIキー ----------

function showKeyModal(show) {
  $('keyModal').hidden = !show;
  if (show) {
    $('keyInput').value = getKey();
    $('keyInput').focus();
  }
}

function saveKey() {
  const v = $('keyInput').value.trim();
  if (v) {
    localStorage.setItem('gururi_key', v);
    setStatus('APIキーを保存しました');
  } else {
    localStorage.removeItem('gururi_key');
    setStatus('APIキーを削除しました');
  }
  showKeyModal(false);
}
