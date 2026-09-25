// Sprout Frame (2026-09-24까지 이름은 Ghost Cam) — 아무렇게나 찍어도 지난 사진과 비교해 주는 식물 성장 카메라.
// 핵심 동작은 하나: 찍고 나서 화분 테두리 양끝을 탭한다. 그러면 앱이 지난 사진을
// 화분 크기·위치·기울기에 맞춰 변형해 겹쳐 보여주고, 얼마나 컸는지 적는다(PROJECT.md §9).
// 저장은 전부 브라우저 안(IndexedDB). 서버로 나가는 것 없음.

import {qrSvg} from './qr.js';

const TARGET_W = 1280;          // 출력 폭  = 4:5. Uncommon Plant 사이트가 사진을 4:5 박스에 object-fit:cover로
                                //          넣기 때문에, 3:4로 찍으면 위아래 6%가 잘렸다.
const TARGET_H = 1600;          // 출력 높이 = 긴 변 1600 (optimize-photos.mjs의 MAX_EDGE와 같음)
const JPEG_Q  = 0.92;

// ── 컷(view) ──────────────────────────────────────────────────────
// 기본은 하나다. 처음(2026-09-17 R7)엔 정면/위/클로즈업 셋을 시켰는데, 실사용에서
// "일이 많고 어렵다"가 됐고 물꽂이 삽수엔 위/클로즈업이 거의 같은 사진이었다.
// 더 필요한 사람은 ＋로 붙인다. 고른 컷을 한 번 더 누르면 이름 바꾸기/빼기.
const DEFAULT_VIEWS = [
  {id:'front', name:'Side', tip:'Roughly from the side, pot in frame. Any distance is fine.'},
];
const LEGACY_VIEW = 'front';    // 컷 개념이 생기기 전에 찍은 사진은 전부 이 컷으로 본다

// ── IndexedDB (의존성 없이 최소한만) ──────────────────────────────
const DB_NAME = 'ghostcam', DB_VER = 1;   // 이름이 Sprout Frame으로 바뀌어도 DB 이름은 그대로 — 바꾸면 기존 사진이 안 보인다
let _db;
function db(){
  if(!_db) _db = new Promise((res, rej) => {
    const r = indexedDB.open(DB_NAME, DB_VER);
    r.onupgradeneeded = () => {
      const d = r.result;
      if(!d.objectStoreNames.contains('plants')) d.createObjectStore('plants', {keyPath:'id'});
      if(!d.objectStoreNames.contains('shots'))  d.createObjectStore('shots',  {keyPath:'id'});
    };
    r.onsuccess = () => res(r.result);
    r.onerror   = () => rej(r.error);
  });
  return _db;
}
const wrap = r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
async function dbGetAll(store){ const d = await db(); return wrap(d.transaction(store).objectStore(store).getAll()); }
async function dbPut(store, val){ const d = await db(); return wrap(d.transaction(store,'readwrite').objectStore(store).put(val)); }
async function dbDel(store, key){ const d = await db(); return wrap(d.transaction(store,'readwrite').objectStore(store).delete(key)); }

// ── DOM ───────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const el = {
  plantBtn:$('plantBtn'), plantNameEl:$('plantName'), addPlant:$('addPlant'),
  picker:$('picker'), plantGrid:$('plantGrid'), pickerClose:$('pickerClose'), labelsBtn:$('labelsBtn'),
  labels:$('labels'), labelGrid:$('labelGrid'), labelsHint:$('labelsHint'), printBtn:$('printBtn'), labelsClose:$('labelsClose'), galleryBtn:$('galleryBtn'), ver:$('ver'),
  views:$('views'),
  stage:$('stage'), video:$('video'), ghost:$('ghost'), grid:$('grid'), tilt:$('tilt'),
  match:$('match'), liveRim:$('liveRim'), flash:$('flash'),
  stageMsg:$('stageMsg'), startBtn:$('startBtn'),
  opacity:$('opacity'), opacityVal:$('opacityVal'),
  modeBtn:$('modeBtn'), gridBtn:$('gridBtn'), flipBtn:$('flipBtn'), restartBtn:$('restartBtn'),
  ghostBtn:$('ghostBtn'),
  shutter:$('shutter'), status:$('status'), canvas:$('canvas'),
  moreBtn:$('moreBtn'), adv:$('adv'), autoBtn:$('autoBtn'), intro:$('intro'), introHint:$('introHint'), introPrivacy:$('introPrivacy'),
  review:$('review'), reviewStage:$('reviewStage'), reviewImg:$('reviewImg'), reviewGhost:$('reviewGhost'),
  reviewSvg:$('reviewSvg'), reviewLayer:$('reviewLayer'), reviewHint:$('reviewHint'),
  compareBtn:$('compareBtn'), rimUndo:$('rimUndo'), retakeBtn:$('retakeBtn'), saveBtn:$('saveBtn'), shareBtn:$('shareBtn'),
  compare:$('compare'), compareTitle:$('compareTitle'), compareClose:$('compareClose'), compareStage:$('compareStage'),
  compareNow:$('compareNow'), compareThen:$('compareThen'), wipe:$('wipe'), wipeLine:$('wipeLine'),
  labelThen:$('labelThen'), labelNow:$('labelNow'), compareInfo:$('compareInfo'), compareMode:$('compareMode'),
  angleBtn:$('angleBtn'), alignedBtn:$('alignedBtn'),
  gallery:$('gallery'), galleryTitle:$('galleryTitle'), galleryClose:$('galleryClose'),
  galleryViews:$('galleryViews'),
  shots:$('shots'), storageInfo:$('storageInfo'), growth:$('growth'),
  exportAll:$('exportAll'), renameBtn:$('renameBtn'), importBtn:$('importBtn'), importFile:$('importFile'), stripBtn:$('stripBtn'), potBtn:$('potBtn'), autoSave:$('autoSave'),
  measure:$('measure'), measureTitle:$('measureTitle'), measureClose:$('measureClose'),
  measureStage:$('measureStage'), measureImg:$('measureImg'), measureSvg:$('measureSvg'), measureLayer:$('measureLayer'),
  measureHint:$('measureHint'), measureUndo:$('measureUndo'), measureSave:$('measureSave'),
};

const state = {
  plants: [], plantId: null,
  viewId: LEGACY_VIEW,
  stream: null, facing: 'environment',
  ghostSource: 'latest',      // 'latest' | 'pinned' | 'none'
  pinnedShot: null,           // Log에서 고정한 사진(ghostSource === 'pinned'일 때)
  ghostUrl: null,
  ghostShot: null,            // 고스트가 저장된 사진이면 그 레코드(기울기 등 메타를 쓰려고)
  pending: null,              // 촬영 후 저장 대기 중인 Blob
  pendingUrl: null,
  pendingTilt: null,
  rim: [],                    // 리뷰 화면에서 탭한 점들 [[x,y],...] — 왼쪽 끝, 오른쪽 끝, (꼭대기)
  galleryView: null,          // 갤러리 필터. null이면 현재 컷
  measuring: null,            // 지난 사진 재측정 중이면 {shot, pts, url}
  compareUrls: [],            // 비교 화면이 만든 objectURL
  cmp: null,                  // 비교 중인 {thenShot, nowShot, mode:'sim'|'h'}
  tilt: null,                 // 방향 센서가 있으면 {beta, gamma} (도 단위, 정수)
  tiltOn: false,              // 리스너를 한 번만 단다
  tiltWasOk: false, okSince: 0, autoArmed: true,   // 자동 촬영 상태
  tiltF: null,                // 부드럽게 한(EMA) 실수 기울기. 판정은 이것으로, 저장은 반올림한 state.tilt로
  ghostVec: null,             // 고스트 사진을 작게 줄인 밝기 벡터(화면 일치도 계산용)
  match: null,                // 지금 화면과 고스트의 일치도(-1~1). null이면 계산 안 함
  matchTimer: 0, scanTimer: 0,
  urls: new Set(),            // 회수해야 할 objectURL
};

const objURL = blob => { const u = URL.createObjectURL(blob); state.urls.add(u); return u; };
const dropURL = u => { if(u){ URL.revokeObjectURL(u); state.urls.delete(u); } };
// 파일 이름에 쓸 수 있는 형태로 줄인다.
// NFKD로 분해해 라틴 악센트만 벗기고(Café → Cafe), **다시 NFC로 합친다.**
// 합치지 않으면 NFKD가 쪼개 놓은 한글 자모가 [가-힣]에 안 걸려 통째로 사라지고,
// 한글 이름 식물이 전부 'plant'가 되어 백업 ZIP 안에서 서로 덮어쓴다(2026-09-16 발견).
const slug = s => (s || '')
  .normalize('NFKD')
  .replace(/[̀-ͯ]/g, '')
  .normalize('NFC')
  .toLowerCase()
  .replace(/[^\w가-힣]+/g, '')
  .slice(0, 24) || 'plant';
const today = () => { const d = new Date(); const p = n => String(n).padStart(2,'0');
  return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}`; };
const uid = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2,8)}`;
const esc = s => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const daysBetween = (a, b) => Math.round(Math.abs(b - a) / 86400000);
// img.decode()는 화면에 안 보이는 탭에서 끝나지 않을 수 있다(검증 중 실측). 기다리되 1.5초 넘기면 그냥 간다.
const decoded = img => Promise.race([img.decode().catch(() => {}), new Promise(r => setTimeout(r, 1500))]);

function say(msg, warn){ el.status.textContent = msg || ''; el.status.classList.toggle('warn', !!warn); }

// ── 식물 목록 ─────────────────────────────────────────────────────
async function loadPlants(){
  state.plants = (await dbGetAll('plants')).sort((a,b) => a.createdAt - b.createdAt);
  // 기본 식물을 넣어두지 않는다. 본인용일 때는 빈 화면을 피하려고 직접 키우는 3종을
  // 넣어뒀는데, 남이 열면 자기 것이 아닌 이름이 들어 있어 "내 기록이 아니다"가 첫인상이 된다.
  const keep = localStorage.getItem('gc.plant');
  state.plantId = state.plants.some(p => p.id === keep) ? keep
                : state.plants.length ? state.plants[0].id : null;
  renderPlants();
  await renderViews();
}
function renderPlants(){
  if(!state.plants.length){
    el.plantNameEl.textContent = 'Add a plant'; state.plantId = null;
    localStorage.removeItem('gc.plant');
    return;
  }
  el.plantNameEl.textContent = plantName();
  localStorage.setItem('gc.plant', state.plantId);
}
async function selectPlant(id){
  state.plantId = id;
  state.ghostSource = 'latest';
  state.galleryView = null;
  renderPlants();
  await renderViews();
  await refreshGhost();
}

// ── 식물 고르기(사진 격자) ─────────────────────────────────────────
// 각 식물의 가장 최근 사진(컷 무관)을 붙인다. 사진이 이름보다 빨리 알아보인다.
let _pickerUrls = [];
async function openPicker(){
  if(!state.plants.length){ await addPlant(); return; }
  _pickerUrls.forEach(dropURL); _pickerUrls = [];
  const shots = await dbGetAll('shots');
  const byPlant = new Map();
  for(const s of shots){
    const o = byPlant.get(s.plantId) || {n:0, latest:null};
    o.n++; if(!o.latest || s.ts > o.latest.ts) o.latest = s;
    byPlant.set(s.plantId, o);
  }
  el.plantGrid.innerHTML = '';
  for(const p of state.plants){
    const o = byPlant.get(p.id) || {n:0, latest:null};
    const b = document.createElement('button');
    b.className = 'shot pick' + (p.id === state.plantId ? ' on' : '');
    let img = '<div class="noimg">🌱</div>';
    if(o.latest){ const u = objURL(o.latest.blob); _pickerUrls.push(u); img = `<img src="${u}" alt="" loading="lazy">`; }
    b.innerHTML = `${img}<div class="name">${esc(p.name)}</div>` +
      `<div class="meta">${o.n ? `${o.n} photo${o.n === 1 ? '' : 's'} · last ${o.latest.date}` : 'No photos yet'}</div>`;
    b.onclick = async () => { closePicker(); if(p.id !== state.plantId) await selectPlant(p.id); };
    el.plantGrid.appendChild(b);
  }
  const add = document.createElement('button');
  add.className = 'shot pick';
  add.innerHTML = '<div class="noimg">＋</div><div class="name">New plant</div><div class="meta">&nbsp;</div>';
  add.onclick = async () => { closePicker(); await addPlant(); };
  el.plantGrid.appendChild(add);
  el.picker.hidden = false;
}
function closePicker(){ el.picker.hidden = true; _pickerUrls.forEach(dropURL); _pickerUrls = []; }
async function addPlant(){
  const name = prompt('Plant name (used in file names)');
  if(!name || !name.trim()) return;
  const p = {id:uid(), name:name.trim(), createdAt:Date.now(), tag:newTag()};
  await dbPut('plants', p); state.plants.push(p);
  await selectPlant(p.id);
}

// ── QR 태그 ───────────────────────────────────────────────────────
// 라벨에는 식물 id가 아니라 따로 만든 짧은 태그를 넣는다. id는 가져오기(Import)할 때 새로 매겨지므로
// id를 넣으면 백업을 옮긴 기기에서 라벨이 안 먹는다. 태그는 내보내기·가져오기로 함께 옮겨진다.
// 헷갈리는 글자(0/o, 1/l/i)는 뺐다 — 사람이 라벨을 옮겨 적을 일이 생겨도 안전하게.
const TAG_CHARS = 'abcdefghjkmnpqrstuvwxyz23456789';
const newTag = () => { const a = crypto.getRandomValues(new Uint8Array(6)); return [...a].map(v => TAG_CHARS[v % TAG_CHARS.length]).join(''); };
// 라벨 내용은 이 앱의 주소 + #t=태그. 앱 안에서 스캔해도 되고, 폰 기본 카메라로 찍으면 브라우저/앱이 그 식물로 열린다.
// 주소는 지금 열린 곳 기준 — 로컬 테스트에서 만든 라벨은 로컬을 가리킨다(공개 주소에서 다시 만들면 된다).
const tagURL = tag => `${location.origin}${location.pathname.replace(/index\.html$/, '')}#t=${tag}`;
const tagFrom = text => { const m = /[#&?]t=([a-z0-9]{4,12})\b/.exec(text || ''); return m ? m[1] : null; };
async function ensureTags(){
  for(const p of state.plants) if(!p.tag){ p.tag = newTag(); await dbPut('plants', p); }
}
async function openLabels(){
  await ensureTags();
  el.labelGrid.innerHTML = state.plants.map(p =>
    `<div class="label">${qrSvg(tagURL(p.tag))}<div class="name">${esc(p.name)}</div></div>`).join('');
  el.labelsHint.textContent = (SCAN ? 'Stick a label on each pot where the camera sees it. When a label is in view, the app switches to that plant by itself. '
                                    : 'Stick a label on each pot. Scan it with your phone\'s camera app to open that plant here. ') +
    'Print at 100% scale: each label is 3 cm.';
  el.labels.hidden = false;
}
// 태그로 식물 전환. 모르는 태그는 다른 기기(또는 지운 식물)의 라벨이다.
async function goToTag(tag, how){
  const p = state.plants.find(o => o.tag === tag);
  if(!p){ say(`This QR label isn't for a plant in this browser.`, true); return false; }
  if(p.id !== state.plantId) await selectPlant(p.id);
  say(`${how}: ${p.name}`);
  return true;
}
// 주소로 들어온 경우(폰 기본 카메라로 라벨을 찍었을 때). 처리한 뒤 주소에서 지운다 — 새로고침 때 다시 바뀌지 않게.
async function tagFromLocation(){
  const t = tagFrom(location.hash);
  if(!t) return;
  history.replaceState(null, '', location.pathname + location.search);
  await goToTag(t, 'QR label');
}

// 카메라 속 라벨 읽기. 안드로이드 크롬에 내장된 BarcodeDetector를 쓴다(라이브러리 없음).
// 아이폰 사파리·윈도 크롬에는 없다 — 그때는 라벨을 폰 기본 카메라로 찍는 쪽(위 주소 방식)으로 간다.
const SCAN = 'BarcodeDetector' in self;
let _detector = null, _scanBusy = false, _lastTag = null, _lastTagAt = 0;
async function scanTick(){
  if(_scanBusy || !state.stream || !el.review.hidden || !el.gallery.hidden || !el.picker.hidden || !el.labels.hidden) return;
  if(!el.video.videoWidth) return;
  _scanBusy = true;
  try{
    if(!_detector){
      const fmts = await BarcodeDetector.getSupportedFormats();
      if(!fmts.includes('qr_code')){ clearInterval(state.scanTimer); state.scanTimer = -1; return; }
      _detector = new BarcodeDetector({formats:['qr_code']});
    }
    const codes = await _detector.detect(el.video);
    const tag = codes.map(c => tagFrom(c.rawValue)).find(Boolean);
    if(!tag) return;
    // 같은 라벨이 계속 보이는 동안은 한 번만 바꾼다. 안 그러면 라벨이 화면에 있는 채로
    // 사용자가 다른 식물을 고르면 즉시 되돌아간다. 5초 넘게 안 보였다가 다시 보이면 새로 본 것으로 친다.
    const now = Date.now(), fresh = tag !== _lastTag || now - _lastTagAt > 5000;
    _lastTag = tag; _lastTagAt = now;
    if(fresh) await goToTag(tag, 'QR label');
  }catch(e){ /* 한 프레임 실패는 무시 — 다음 틱에 다시 */ }
  finally{ _scanBusy = false; }
}
const plant = () => state.plants.find(p => p.id === state.plantId) || null;
const plantName = () => (plant() || {}).name || 'plant';

// ── 컷(view) ──────────────────────────────────────────────────────
const viewsOf = p => (p && p.views && p.views.length) ? p.views : DEFAULT_VIEWS;
const viewById = id => viewsOf(plant()).find(v => v.id === id) || viewsOf(plant())[0];
const viewName = id => (viewsOf(plant()).find(v => v.id === id) || {name:id}).name;
const shotView = s => s.view || LEGACY_VIEW;

async function renderViews(){
  const p = plant();
  if(!p){ el.views.innerHTML = ''; return; }
  const views = viewsOf(p);
  if(!views.some(v => v.id === state.viewId)) state.viewId = views[0].id;
  const doneToday = new Set((await shotsOf(p.id)).filter(s => s.date === today()).map(shotView));
  el.views.innerHTML = views.map(v =>
    `<button class="chip view${v.id === state.viewId ? ' on' : ''}${doneToday.has(v.id) ? ' done' : ''}" data-view="${v.id}">${esc(v.name)}${doneToday.has(v.id) ? ' ✓' : ''}</button>`
  ).join('') + `<button class="chip view add" id="addView" title="Add a view">＋</button>`;
  el.views.querySelectorAll('[data-view]').forEach(b => b.onclick = () =>
    b.dataset.view === state.viewId ? editView(b.dataset.view) : selectView(b.dataset.view));
  $('addView').onclick = addView;
  el.views.hidden = views.length === 1 && el.adv.hidden;     // 컷이 하나뿐이면 접힌 동안 줄을 숨긴다
}
async function selectView(id){
  state.viewId = id;
  state.ghostSource = 'latest';
  await renderViews();
  await refreshGhost();
}
async function addView(){
  const p = plant(); if(!p) return;
  const name = prompt('Name for the new view (e.g. Top, Roots)');
  if(!name || !name.trim()) return;
  const views = viewsOf(p).slice();
  const id = slug(name) + '-' + uid().slice(-4);
  views.push({id, name:name.trim(), tip:''});
  p.views = views;
  await dbPut('plants', p);
  await selectView(id);
}
async function editView(id){
  const p = plant(); if(!p) return;
  const views = viewsOf(p).map(v => Object.assign({}, v));
  const v = views.find(x => x.id === id); if(!v) return;
  const ans = prompt(`Rename "${v.name}", or type remove to drop this view. Photos already taken stay in the Log.`, v.name);
  if(ans === null || !ans.trim() || ans.trim() === v.name) return;
  if(ans.trim().toLowerCase() === 'remove'){
    if(views.length === 1){ say('Keep at least one view.', true); return; }
    p.views = views.filter(x => x.id !== id);
  }else{
    v.name = ans.trim(); p.views = views;
  }
  await dbPut('plants', p);
  await renderViews(); await refreshGhost();
}

// ── 기준(고스트) 사진 ─────────────────────────────────────────────
async function shotsOf(plantId, viewId){
  return (await dbGetAll('shots'))
    .filter(s => s.plantId === plantId && (!viewId || shotView(s) === viewId))
    .sort((a,b) => b.ts - a.ts);
}
let _ghostGen = 0;
async function refreshGhost(){
  // 빨리 연달아 부르면(끄기 → 켜기 → 고정) 앞 호출의 사진 로딩이 늦게 끝나 뒤 상태를 덮었다(검증 중 실측).
  // 호출마다 번호를 매기고, 기다린 뒤 번호가 바뀌었으면 손을 뗀다.
  const gen = ++_ghostGen;
  dropURL(state.ghostUrl); state.ghostUrl = null; state.ghostShot = null;
  state.ghostVec = null; state.match = null; drawLiveRim();
  renderTilt();
  // 고스트 버튼은 켜기/끄기 둘뿐이다(v33). 전에는 지난 사진 → 앨범 파일 고르기 → 끄기로 돌아서, 모르고 누르면
  // 앨범 사진이 기준이 됐다. 앨범 사진엔 기울기 기록이 없어 과녁이 사라지고 매치가 8%로 떨어졌다(2026-09-24 실사용).
  // 특정 사진을 기준으로 쓰려면 Log에서 그 사진의 Ghost를 누른다(pinned).
  if(state.ghostSource === 'none'){ el.ghost.hidden = true; el.ghostBtn.textContent = 'Ghost: off'; el.ghostBtn.classList.remove('on'); return; }
  el.ghostBtn.classList.add('on');
  if(!state.plantId){
    el.ghost.hidden = true; el.ghost.removeAttribute('src');
    el.ghostBtn.textContent = 'Ghost: on';
    say('Add a plant with ＋ above to get started.');
    return;
  }
  const v = viewById(state.viewId);
  const pinned = state.ghostSource === 'pinned' && state.pinnedShot;
  const [latest] = pinned ? [state.pinnedShot] : await shotsOf(state.plantId, v.id);
  if(gen !== _ghostGen) return;
  el.ghostBtn.textContent = pinned ? `Ghost: ${latest.date}` : 'Ghost: on';
  if(!latest){
    el.ghost.hidden = true; el.ghost.removeAttribute('src');
    say(`First shot. ${v.tip}`.trim());
    return;
  }
  state.ghostShot = latest;
  state.ghostUrl = objURL(latest.blob);
  el.ghost.hidden = true;                       // 새 사진이 디코딩되기 전까지 옛 고스트가 보이지 않게
  el.ghost.src = state.ghostUrl;
  await decoded(el.ghost);
  if(gen !== _ghostGen) return;
  el.ghost.hidden = false;
  say(pinned ? `Ghost pinned to ${latest.date}. Tap Ghost to go back to the last shot.`
             : `Last shot ${latest.date} is shown faintly. Shoot, then tap the pot rim twice.`);
  applyOpacity(); renderTilt(); ghostChanged();
}
function applyOpacity(){
  const v = +el.opacity.value;
  el.opacityVal.textContent = v + '%';
  el.ghost.style.opacity = v / 100;
}

// ── 기울기 ────────────────────────────────────────────────────────
// 찍을 때의 보조. 기준 사진을 찍을 때의 각도를 저장했다가 "3° 더 세워라"처럼 알려준다.
//   beta  = 앞뒤 기울기 (0 = 바닥과 평행, 90 = 똑바로 세움)
//   gamma = 좌우 기울기 (0 = 수평, 오른쪽으로 기울면 +)
// iOS는 사용자 제스처 안에서 허락을 받아야 하므로 '카메라 켜기' 버튼에서 부른다.
// 허용 오차의 변천(전부 실사용에서 나왔다):
//  ±3° ✓ → "그 안에서도 더 민감하게"(09-23) → ±1° ✓ → "공이 원 안에 정확히 들어갔을 때부터 1초였으면,
//  근처에만 가도 시작해 빨리 찍힌다"(09-23) → **±0.5°**. 게다가 전에는 센서 값을 정수로 반올림해 비교해서
//  ±1°가 실제로는 1.49°까지였다. 이제 실수로 비교한다.
// 들어갈 때 0.5°, 나갈 때 0.65°(히스테리시스) — 손 떨림 한 번에 1초가 리셋되지 않게. 0.65°는 점이 원 테두리에
// 살짝 닿는 자리다. 더 크게 잡으면 점이 원 밖으로 나갔는데도 초록이 남아 "정확히 들어갔을 때"와 어긋난다.
const TILT_OK = 0.5, TILT_OK_EXIT = 0.65, TILT_NEAR = 2;
const TILT_SMOOTH = 0.25;         // 센서 흔들림을 누르는 지수이동평균 계수. 60Hz에서 약 70ms 지연 — 감
async function initTilt(){
  if(state.tiltOn || !('DeviceOrientationEvent' in window)) return;
  if(typeof DeviceOrientationEvent.requestPermission === 'function'){
    const r = await DeviceOrientationEvent.requestPermission().catch(() => 'denied');
    if(r !== 'granted') return;
  }
  state.tiltOn = true;
  let last = 0;
  window.addEventListener('deviceorientation', e => {
    if(e.beta == null) return;
    const f = state.tiltF;
    state.tiltF = f ? {beta: f.beta + (e.beta - f.beta) * TILT_SMOOTH, gamma: f.gamma + (e.gamma - f.gamma) * TILT_SMOOTH}
                    : {beta: e.beta, gamma: e.gamma};
    state.tilt = {beta: Math.round(state.tiltF.beta * 10) / 10, gamma: Math.round(state.tiltF.gamma * 10) / 10};
    const now = performance.now();                 // 센서는 초당 60번 온다. 점이 부드럽게 움직이도록 30번
    if(now - last > 33){ last = now; renderTilt(); }
  });
}
// 표시 방식(2026-09-23 사용자: "좀 더 게임처럼, 어디다 뭘 넣는 느낌으로"):
// 오른쪽 위 원 안에서 점이 폰 기울기를 따라 움직이고, 가운데 작은 원(±1°)에 넣으면 초록 + 짧은 진동.
// 점은 "폰을 기울이는 쪽으로" 움직인다 — 오른쪽으로 기울이면 오른쪽, 세우면 위. 조작한 대로 따라와야 게임처럼 느껴진다.
// 거리는 비선형(d/(d+3))으로 줄인다. 선형이면 1°가 2px이라 가운데 근처에서 안 움직이는 것처럼 보인다.
// 0.5°≈4.7px(= 가운데 원 안쪽 경계), 2°≈13px(점선), 10°≈25px, 그 이상은 가장자리에 붙는다.
// 가운데 원 크기는 "공이 원 안에 완전히 들어간 순간"이 딱 0.5°가 되도록 이 식에서 역산했다.
function renderTilt(){
  // 일치도는 타이머로도 돌지만, 백그라운드·절전에서 타이머가 늦춰지므로 센서 신호가 올 때도 갱신한다.
  if(state.stream && performance.now() - _lastMatch > 125) matchTick();
  const cur = state.tilt;
  if(!cur){ el.tilt.hidden = true; return; }
  if(!el.tilt.querySelector('.pad')){
    el.tilt.innerHTML = '<div class="pad"><i class="ring near"></i><i class="ring ok"></i><b class="dot"></b></div><span class="cap"></span>';
  }
  const pad = el.tilt.querySelector('.pad'), dot = el.tilt.querySelector('.dot'), cap = el.tilt.querySelector('.cap');
  const ref = state.ghostShot && state.ghostShot.tilt;
  el.tilt.hidden = false;
  if(!ref){
    pad.hidden = true; cap.textContent = `Tilt ${Math.round(cur.beta)}°`;
    el.tilt.classList.remove('ok', 'near'); state.tiltWasOk = false;
    return;
  }
  pad.hidden = false;
  const f = state.tiltF || cur;
  const db = ref.beta - f.beta, dg = ref.gamma - f.gamma;
  const worst = Math.max(Math.abs(db), Math.abs(dg));
  const ok = worst <= (state.tiltWasOk ? TILT_OK_EXIT : TILT_OK);
  el.tilt.classList.toggle('ok', ok);
  el.tilt.classList.toggle('near', !ok && worst <= TILT_NEAR);
  const d = Math.hypot(db, dg), R = 33, r = d ? R * d / (d + 3) : 0;
  dot.style.transform = d ? `translate(${(-dg / d) * r}px, ${(db / d) * r}px)` : '';
  const fmt = v => v < 2 ? v.toFixed(1) : String(Math.round(v));
  const mOk = matchOk();
  if(ok){ cap.textContent = mOk ? '✓' : '✓ tilt · line up the photo'; }
  else{
    const parts = [];
    if(Math.abs(db) >= 0.3) parts.push(`${db > 0 ? '↑' : '↓'}${fmt(Math.abs(db))}°`);   // ↑ = 폰 윗부분을 더 세워라
    if(Math.abs(dg) >= 0.3) parts.push(`${dg > 0 ? '→' : '←'}${fmt(Math.abs(dg))}°`);   // → = 오른쪽으로 더 기울여라
    cap.textContent = parts.join(' ');
  }
  if(ok && !state.tiltWasOk && navigator.vibrate) navigator.vibrate(15);   // 들어가는 순간 한 번
  state.tiltWasOk = ok;
  autoShoot(ok && mOk);
}
// 자동 촬영(2026-09-23 사용자: "맞춘 뒤 셔터를 누르다 보면 살짝 틀어진다. 유지되면 알아서 찍어 달라").
// 과녁 안(±1°)에 AUTO_HOLD 동안 머물면 찍는다. 원 테두리가 차오르며 남은 시간을 보여준다.
// 1초는 감으로 정한 값 — 짧으면 스쳐 지나갈 때 찍히고, 길면 팔이 떨려 못 버틴다.
// 한 번 찍은 뒤에는 과녁을 한 번 벗어나야 다시 장전된다. 안 그러면 저장 직후 방금 찍은 사진이
// 새 기준이 되어(각도가 같으니) 바로 또 찍힌다.
const AUTO_HOLD = 1000;
// 1초가 흐르는 것을 보여준다(2026-09-23 사용자 요청). **Shoot 버튼 하나로만.**
// v27엔 과녁 테두리가, v29엔 버튼도 차올라 둘이 겹쳤다 — "굳이 두 개가 필요할까"(사용자) → 버튼만 남김(사용자 선택).
function holdProgress(p){
  el.shutter.style.setProperty('--p', p);
  const holding = p > 0;
  if(holding !== el.shutter.classList.contains('holding')){
    el.shutter.classList.toggle('holding', holding);
    el.shutter.textContent = holding ? 'Hold still…' : 'Shoot';
  }
}
// 찍히는 순간 화면이 한 번 하얗게 번쩍인다 — 자동 촬영은 손으로 누르지 않으니 "찍혔다"를 따로 알려야 한다.
function flash(){
  el.flash.classList.remove('on'); void el.flash.offsetWidth; el.flash.classList.add('on');
}
function autoShoot(ok){
  const pad = el.tilt.querySelector('.pad');
  const on = localStorage.getItem('gc.autoshoot') !== 'no';
  const ready = on && state.stream && !el.shutter.disabled && el.review.hidden && el.compare.hidden && el.gallery.hidden;
  if(!ok) state.autoArmed = true;
  if(!ok || !ready || !state.autoArmed){ state.okSince = 0; holdProgress(0); return; }
  const now = performance.now();
  if(!state.okSince) state.okSince = now;
  const p = Math.min(1, (now - state.okSince) / AUTO_HOLD);
  holdProgress(p);
  if(p >= 1){
    state.autoArmed = false; state.okSince = 0; holdProgress(0);
    if(navigator.vibrate) navigator.vibrate([20, 40, 20]);
    flash();
    capture();
  }
}

// ── 화면 전체 일치도 ──────────────────────────────────────────────
// 기울기는 폰의 각도만 안다. 거리·위치가 달라도 각도만 같으면 초록이 떴고, 실사용(2026-09-23)에서
// "화분 아래는 하나도 안 맞는데 맞다고 나온다, 전체를 보고 가자"가 나왔다.
// 그래서 카메라 화면과 고스트 사진을 48×60으로 줄여 **통째로** 비교한다(정규화 상호상관, NCC).
//  - 비교 대상은 밝기가 아니라 **윤곽(밝기 변화의 세기)**이다. 처음엔 밝기를 그대로 비교했는데 너무 너그러웠다 —
//    넓은 벽·바닥이 점수를 받쳐 줘서 화면 폭 14%를 옮겨도 76%가 나왔다. 윤곽으로 바꾸니(가짜 장면 실측):
//      어긋남      밝기   윤곽
//      3% 옆       0.95   0.75
//      6% 옆       0.89   0.59
//      10% 크기    0.93   0.53
//  - 평균을 빼고 크기로 나누므로(NCC) 조명이 조금 달라도 값이 크게 흔들리지 않는다.
//  - 48×60은 감이다. 폰에서 초당 8번 돌려도 부담이 없고, 잎 하나하나보다 큰 구도를 본다. 96×120은 더 까다롭기만 했다.
// 자동 촬영 문턱 MATCH_MIN=0.6도 감이다 — 위 표에서 3%는 통과, 6%부터 막히는 자리. 실제 사진은 식물이 자라고 빛이
// 바뀌어 맞춰도 100%가 안 나온다. 맞췄는데도 자동 촬영이 안 되면 이 숫자를 내린다.
const MATCH_W = 48, MATCH_H = 60, MATCH_MIN = 0.6;
const _mA = document.createElement('canvas'); _mA.width = MATCH_W * 4; _mA.height = MATCH_H * 4;
const _mB = document.createElement('canvas'); _mB.width = MATCH_W; _mB.height = MATCH_H;
function vecOf(src, sw0, sh0){
  if(!sw0 || !sh0) return null;
  const {sx, sy, sw, sh} = cropRect(sw0, sh0);         // 화면·저장과 같은 4:5 중앙 크롭
  const a = _mA.getContext('2d'), b = _mB.getContext('2d', {willReadFrequently:true});
  a.imageSmoothingQuality = 'high'; b.imageSmoothingQuality = 'high';
  a.drawImage(src, sx, sy, sw, sh, 0, 0, _mA.width, _mA.height);     // 두 단계로 줄여야 계단 현상이 덜하다
  b.drawImage(_mA, 0, 0, MATCH_W, MATCH_H);
  const px = b.getImageData(0, 0, MATCH_W, MATCH_H).data, n = MATCH_W * MATCH_H, W = MATCH_W;
  const g = new Float32Array(n), v = new Float32Array(n);
  for(let i = 0; i < n; i++) g[i] = px[i*4] * 0.299 + px[i*4+1] * 0.587 + px[i*4+2] * 0.114;
  for(let y = 1; y < MATCH_H - 1; y++) for(let x = 1; x < W - 1; x++){       // 가운데 차분으로 윤곽 세기
    const i = y * W + x;
    v[i] = Math.hypot(g[i+1] - g[i-1], g[i+W] - g[i-W]);
  }
  let mean = 0;
  for(let i = 0; i < n; i++) mean += v[i];
  mean /= n;
  let ss = 0;
  for(let i = 0; i < n; i++){ v[i] -= mean; ss += v[i] * v[i]; }
  if(ss < 1e-3) return null;                               // 단색 화면은 비교할 게 없다
  const k = 1 / Math.sqrt(ss);
  for(let i = 0; i < n; i++) v[i] *= k;
  return v;
}
async function ghostChanged(){
  state.ghostVec = null; state.match = null;
  drawLiveRim();
  if(el.ghost.hidden || !el.ghost.src) return;
  await decoded(el.ghost);
  state.ghostVec = vecOf(el.ghost, el.ghost.naturalWidth, el.ghost.naturalHeight);
}
let _lastMatch = 0;
function matchTick(){
  _lastMatch = performance.now();
  const show = state.stream && state.ghostVec && el.review.hidden && !el.ghost.hidden;
  if(!show){ el.match.hidden = true; state.match = null; return; }
  const live = vecOf(el.video, el.video.videoWidth, el.video.videoHeight);
  if(!live){ el.match.hidden = true; state.match = null; return; }
  let s = 0; const g = state.ghostVec;
  for(let i = 0; i < live.length; i++) s += live[i] * g[i];
  state.match = s;
  const pct = Math.max(0, Math.round(s * 100));
  // 문턱을 같이 적는다. 사용자가 "지금 몇 %고 몇 %면 되나"를 물었다 — 숫자만 있으면 기준을 모른다.
  el.match.textContent = s >= MATCH_MIN ? `Match ${pct}% ✓` : `Match ${pct}% · need ${Math.round(MATCH_MIN * 100)}`;
  el.match.classList.toggle('good', s >= MATCH_MIN);
  el.match.hidden = false;
}
// 일치도를 모르면(고스트 없음·계산 전) 막지 않는다. 막으면 자동 촬영이 이유 없이 안 되는 것처럼 보인다.
const matchOk = () => state.match == null || state.match >= MATCH_MIN;
// 지난 사진에서 탭한 테두리 양끝을 카메라 위에 점선으로 — 화분 입구를 이 선에 맞추면 거리·위치가 맞는다.
// v31에서 한 번 뺐다가 v32에서 되살렸다(2026-09-23). 사용자가 점선을 기억하지 못한 채 설명만 듣고 빼기로 했는데,
// "실제로 보고 판단하고 싶다, 빼기로 한 건 잘못된 것 같다"고 뒤집었다. 판정은 폰에서 직접 본 뒤에.
function drawLiveRim(){
  if(!el.liveRim) return;              // 옛 HTML이 캐시에 남아 새 JS와 섞인 경우(버전 교체 순간) 멈추지 않게
  const m = state.ghostShot && rimOf(state.ghostShot);
  if(!m || el.ghost.hidden){ el.liveRim.toggleAttribute('hidden', true); return; }   // <svg>는 .hidden이 안 먹는다
  const [l, r] = [m.l, m.r].map(toPx);
  el.liveRim.innerHTML = `<line x1="${l[0]}" y1="${l[1]}" x2="${r[0]}" y2="${r[1]}"/>` +
    `<circle cx="${l[0]}" cy="${l[1]}" r="16"/><circle cx="${r[0]}" cy="${r[1]}" r="16"/>`;
  el.liveRim.toggleAttribute('hidden', false);
}

// ── 카메라 ────────────────────────────────────────────────────────
function stopCamera(){
  if(state.stream){ state.stream.getTracks().forEach(t => t.stop()); state.stream = null; }
}
async function startCamera(){
  if(!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia){
    say("This browser can't use the camera here. Open the page over https or localhost.", true); return;
  }
  stopCamera();
  initTilt();   // 사용자 제스처 안이어야 iOS가 허락을 묻는다. 기다리지 않는다 — 카메라가 먼저다
  try{
    // 크게 부른다. `ideal`은 못 맞춰도 실패하지 않고 가장 가까운 걸 주므로 손해가 없다.
    // 1600×2000으로 부르니 폰이 1080×1920만 줬다(2026-08-21 실측) — 그러면 1080×1350으로
    // 잘려 19% 확대 저장된다. 목표(1280 폭)를 여유 있게 넘기려고 2560×3200으로 올렸다.
    state.stream = await navigator.mediaDevices.getUserMedia({
      audio:false,
      video:{ facingMode:{ideal:state.facing}, width:{ideal:2560}, height:{ideal:3200} }
    });
  }catch(err){
    say(`Couldn't open the camera: ${err.name}\nPermission may have been denied, or another app is using it.`, true);
    return;
  }
  el.video.srcObject = state.stream;
  await el.video.play().catch(() => {});
  el.stageMsg.hidden = true;
  el.shutter.disabled = false;
  if(!state.matchTimer) state.matchTimer = setInterval(matchTick, 125);   // 초당 8번
  // 라벨 읽기는 초당 2번이면 충분하다. 식물을 바꾸는 건 드문 일이고, 매치 계산과 겹치면 폰이 버벅인다.
  if(SCAN && !state.scanTimer) state.scanTimer = setInterval(scanTick, 500);
  watchStream(state.stream);
  reportResolution();
}

// 폰에서 카메라가 멈추는 일이 있다(다른 앱이 가져갔거나, 화면을 껐다 켰거나).
// 화면은 마지막 프레임에 얼어붙은 채 남아서 **멈춘 줄도 모르고 찍게 된다.** 그래서 감지해 알린다.
function watchStream(stream){
  stream.getVideoTracks().forEach(t => {
    t.addEventListener('ended', () => { say('Camera disconnected. Restarting…', true); startCamera(); });
    t.addEventListener('mute',  () => say('Camera stalled. Tap ‘Restart camera’.', true));
    t.addEventListener('unmute',() => reportResolution());
  });
}
// 앱을 다시 앞으로 가져왔을 때 스트림이 죽어 있으면 되살린다.
document.addEventListener('visibilitychange', async () => {
  if(document.visibilityState !== 'visible' || !state.stream) return;
  const [t] = state.stream.getVideoTracks();
  if(!t || t.readyState === 'ended' || t.muted) await startCamera();
  else el.video.play().catch(() => {});
});
// 실제로 저장될 픽셀 수를 계산해 목표(1280×1600)에 못 미치면 숨기지 않고 알린다.
function reportResolution(){
  const vw = el.video.videoWidth, vh = el.video.videoHeight;
  if(!vw) return;
  const {sw, sh} = cropRect(vw, vh);
  if(sw < TARGET_W){
    // 예전 문구는 "폰 후면 카메라를 쓰면 해결된다"였는데, 폰에서 이미 후면 카메라를 쓰는
    // 상황에서는 틀린 조언이 된다. 무엇이 부족한지만 사실대로 적는다.
    const pct = Math.round((TARGET_W / sw - 1) * 100);
    say(`Camera ${vw}×${vh} → crop ${Math.round(sw)}×${Math.round(sh)}.\n` +
        `Below the ${TARGET_W}×${TARGET_H} target, so the file is upscaled ${pct}% (softer image). ` +
        `This is the most this browser can get from the camera.`, true);
  }else{
    say(`Camera ${vw}×${vh} → saved at ${TARGET_W}×${TARGET_H}`);
  }
}
// 화면(object-fit:cover)과 똑같은 중앙 크롭. 보이는 것과 저장되는 것이 어긋나면 도구의 의미가 없다.
function cropRect(vw, vh){
  const ar = TARGET_W / TARGET_H;
  let sw, sh;
  if(vw / vh > ar){ sh = vh; sw = vh * ar; } else { sw = vw; sh = vw / ar; }
  return {sx:(vw - sw)/2, sy:(vh - sh)/2, sw, sh};
}

// ── 테두리·꼭대기 탭 — 사진을 숫자로 바꾸는 유일한 입력 ───────────
// 사진 속 크기는 카메라 거리에 따라 변하므로 그대로는 못 비교한다. 대신 **사진마다 화분이 같이
// 찍혀 있고, 화분의 실제 크기는 안 변한다.** 테두리 양끝 두 점이 화분의 크기·위치·기울기를 준다.
// 세 번째 점(꼭대기)은 선택 — 있으면 키가 나온다. 좌표는 저장 픽셀(1280×1600) 기준 0~1.
// 영상 인식은 쓰지 않는다. 투명 컵은 인식이 가장 어렵고, 브라우저 모델은 의존성 0개를 깬다.
const RIM_STEPS = [
  'Tap the LEFT edge of the pot rim.',
  'Now the RIGHT edge of the rim.',
  'Optional: tap the TOP of the plant for height. Or just Save.',
];
const toPx = ([x, y]) => [x * TARGET_W, y * TARGET_H];
const isPt = q => Array.isArray(q) && q.length === 2 && q.every(Number.isFinite);
// 좌표가 숫자가 아닌 레코드는 없는 것으로 본다. 화면 크기가 0인 순간에 탭이 들어오면 NaN이
// 저장될 수 있는데(검증 중 실제로 생김), 그런 사진이 비교 상대로 잡히면 결과가 전부 NaN이 된다.
function rimOf(s){ const m = s.measure; return m && isPt(m.l) && isPt(m.r) ? m : null; }
// 키: 꼭대기에서 테두리 선까지의 수직 거리. 폰이 조금 기울어도 테두리 선 기준이라 덜 흔들린다.
// 화분 지름(cm)이 있으면 cm, 없으면 '테두리 폭 대비 배수'. 둘 다 볼 때 계산한다 — 저장하지 않는다.
// 그래야 지름을 나중에 적어도 과거 사진 전부가 cm로 바뀐다.
function heightOf(s, potCm){
  const m = rimOf(s); if(!m || !m.t) return null;
  const [l, r, t] = [m.l, m.r, m.t].map(toPx);
  const dx = r[0] - l[0], dy = r[1] - l[1];
  const rim = Math.hypot(dx, dy);
  if(rim < 10) return null;
  const perp = Math.abs(dx * (t[1] - l[1]) - dy * (t[0] - l[0])) / rim;
  const ratio = perp / rim;
  return {ratio, cm: potCm ? Math.round(ratio * potCm * 10) / 10 : null};
}
const fmtHeight = h => !h ? '' : h.cm != null ? `${h.cm} cm` : `${h.ratio.toFixed(2)}× pot`;
function drawTaps(svg, pts, potCm){
  const P = pts.map(toPx), out = [];
  if(P.length >= 2) out.push(`<line x1="${P[0][0]}" y1="${P[0][1]}" x2="${P[1][0]}" y2="${P[1][1]}"/>`);
  if(P.length === 3){
    const [l, r, t] = P, dx = r[0]-l[0], dy = r[1]-l[1], len = Math.hypot(dx, dy) || 1;
    const k = ((t[0]-l[0])*dx + (t[1]-l[1])*dy) / (len*len);
    const fx = l[0] + k*dx, fy = l[1] + k*dy;
    out.push(`<line class="h" x1="${t[0]}" y1="${t[1]}" x2="${fx}" y2="${fy}"/>`);
    const h = heightOf({measure:{l:pts[0], r:pts[1], t:pts[2]}}, potCm);
    if(h) out.push(`<text x="${Math.min(t[0]+40, TARGET_W-420)}" y="${(t[1]+fy)/2}">${fmtHeight(h)}</text>`);
  }
  P.forEach(([x, y]) => out.push(`<circle cx="${x}" cy="${y}" r="22"/>`));
  svg.innerHTML = out.join('');
}
function tapAt(ev, stage){
  const r = stage.getBoundingClientRect();
  if(!(r.width > 0 && r.height > 0)) return null;     // 아직 그려지지 않은 화면의 탭은 버린다
  const t = ev.touches ? ev.touches[0] : ev;
  return [Math.min(1, Math.max(0, (t.clientX - r.left) / r.width)),
          Math.min(1, Math.max(0, (t.clientY - r.top) / r.height))];
}
const measureOf = pts => pts.length >= 2 && isPt(pts[0]) && isPt(pts[1])
  ? {l:pts[0], r:pts[1], t:isPt(pts[2]) ? pts[2] : undefined} : undefined;
// 각도 보정용 4점: 테두리의 왼쪽·오른쪽 끝(이미 있음) + 앞쪽 끝·뒤쪽 끝. 네 점이 테두리가 놓인 평면을 정한다.
const QUAD_STEPS = [
  'Tap the FRONT edge of the rim (the point closest to you).',
  'Tap the BACK edge of the rim (the point farthest from you).',
];
function quadOf(s){ const m = rimOf(s); return m && isPt(m.f) && isPt(m.b) ? [m.l, m.r, m.f, m.b] : null; }
function drawQuad(svg, pts){
  const P = pts.map(toPx), out = [];
  if(P.length >= 2) out.push(`<line x1="${P[0][0]}" y1="${P[0][1]}" x2="${P[1][0]}" y2="${P[1][1]}"/>`);
  if(P.length === 4) out.push(`<line class="h" x1="${P[2][0]}" y1="${P[2][1]}" x2="${P[3][0]}" y2="${P[3][1]}"/>`);
  P.forEach(([x, y], i) => out.push(`<circle cx="${x}" cy="${y}" r="22"${i < 2 ? ' class="fixed"' : ''}/>`));
  svg.innerHTML = out.join('');
}

// ── 촬영 ──────────────────────────────────────────────────────────
// 폰 실사용(2026-09-17 v23)에서 "두 번째로 찍은 사진의 리뷰에 첫 번째 사진이 떴다"가 세 번 연속 났다.
// 한 장씩 밀리는 것. 원인 후보는 둘이고 둘 다 막는다:
//  ① <video>가 멈춘 프레임을 들고 있어 drawImage가 옛 장면을 그린다 → 찍기 직전에 **새 프레임이 실제로
//     도착하는 것을 기다린다**(requestVideoFrameCallback). 1.5초 안에 안 오면 찍지 않고 알린다.
//  ② 리뷰의 <img>가 새 src를 반영하지 않는다 → 매번 **새 <img> 요소를 만들어** load 이벤트 뒤에 바꿔 끼운다.
async function freshFrame(){
  await el.video.play().catch(() => {});
  const t0 = el.video.currentTime;
  const byFrame = typeof el.video.requestVideoFrameCallback === 'function'
    ? new Promise(res => {
        let done = false;
        const id = el.video.requestVideoFrameCallback(() => { done = true; res(true); });
        setTimeout(() => { if(!done){ el.video.cancelVideoFrameCallback(id); res(false); } }, 1500);
      })
    : Promise.resolve(false);
  if(await byFrame) return true;
  // 프레임 콜백은 화면에 실제로 그려질 때만 온다(탭이 가려져 있으면 안 온다). 재생 시각이 흐르고
  // 있으면 스트림은 살아 있는 것이므로 그것을 두 번째 근거로 삼는다.
  await new Promise(r => setTimeout(r, 300));
  return el.video.currentTime > t0;
}
async function capture(){
  // 식물이 하나도 없으면 찍어도 넣을 곳이 없다. 찍고 나서 실패하면 그 한 장을 잃는다.
  if(!state.plantId){ say('Add a plant with ＋ above first.', true); return; }
  if(el.shutter.disabled || !el.review.hidden) return;   // 리뷰가 열려 있는 동안 또 찍으면 탭한 점이 지워진다
  el.shutter.disabled = true;                       // 두 번 눌리는 것 방지
  try{
    if(!(await freshFrame())){ say('Camera looks frozen — tap ‘Restart camera’ and shoot again.', true); return; }
    await captureFrame();
  }finally{ el.shutter.disabled = false; }
}
async function captureFrame(){
  const vw = el.video.videoWidth, vh = el.video.videoHeight;
  if(!vw){ say("Video isn't ready yet.", true); return; }
  const {sx, sy, sw, sh} = cropRect(vw, vh);
  el.canvas.width = TARGET_W; el.canvas.height = TARGET_H;
  const ctx = el.canvas.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(el.video, sx, sy, sw, sh, 0, 0, TARGET_W, TARGET_H);
  const blob = await new Promise(r => el.canvas.toBlob(r, 'image/jpeg', JPEG_Q));
  state.pending = blob;
  state.pendingTilt = state.tilt ? Object.assign({}, state.tilt) : null;
  dropURL(state.pendingUrl);
  state.pendingUrl = objURL(blob);
  // 새 <img>를 만들어 load가 끝난 뒤에 바꿔 끼운다. src만 바꾸면 브라우저는 새 사진이 준비될 때까지
  // 직전 사진을 그대로 보여주고, 폰에서는 그게 계속 남는 경우가 있었다(2026-09-17 실사용).
  const img = new Image();
  img.alt = 'Just taken';
  await new Promise(res => { img.onload = res; img.onerror = res; setTimeout(res, 3000); img.src = state.pendingUrl; });
  el.reviewImg.replaceWith(img); el.reviewImg = img; img.id = 'reviewImg';
  if(state.ghostUrl){ el.reviewGhost.src = state.ghostUrl; el.compareBtn.disabled = false; }
  else { el.reviewGhost.removeAttribute('src'); el.compareBtn.disabled = true; }
  state.rim = []; drawRim();
  el.review.hidden = false;
}
function drawRim(){
  drawTaps(el.reviewSvg, state.rim, (plant() || {}).potCm);
  el.rimUndo.disabled = !state.rim.length;
  el.reviewHint.textContent = state.rim.length < 3 ? RIM_STEPS[state.rim.length]
    : 'Got it. Save to keep the photo and compare with last time.';
}
function rimTap(ev){
  if(state.rim.length >= 3) return;
  ev.preventDefault();
  const q = tapAt(ev, el.reviewStage); if(!q) return;
  state.rim.push(q);
  drawRim();
}

async function save(){
  if(!state.pending) return;
  const shot = {
    id: uid(), plantId: state.plantId, view: state.viewId, ts: Date.now(), date: today(),
    w: TARGET_W, h: TARGET_H, blob: state.pending,
    tilt: state.pendingTilt || undefined,
    measure: measureOf(state.rim),
  };
  try{ await dbPut('shots', shot); }
  catch(err){ say(`Save failed: ${err.name}. Storage may be full.`, true); return; }
  // 브라우저가 공간을 회수하면 사진이 사라진다. 첫 저장 때 영구 보관을 요청해 둔다.
  if(navigator.storage && navigator.storage.persist && !localStorage.getItem('gc.persisted')){
    const ok = await navigator.storage.persist().catch(() => false);
    localStorage.setItem('gc.persisted', ok ? 'yes' : 'no');
  }
  // 2026-09-17 첫 실사용에서 뒤집힘: "Save 눌렀는데 사진첩에 없다." 사용자에게 Save = 내 사진첩이다.
  // 앱 안(IndexedDB)에만 남으면 저장이 안 된 것으로 읽힌다. 그래서 값이 없으면 켜짐('no'일 때만 건너뜀).
  const downloaded = localStorage.getItem('gc.autosave') !== 'no';
  if(downloaded) download(state.pending, shotFileName(shot));
  state.pending = null;
  el.review.hidden = true;
  // 비교 상대: 같은 컷에서 테두리가 찍힌 직전 사진
  const prev = (await shotsOf(state.plantId, shot.view)).find(s => s.id !== shot.id && rimOf(s));
  state.ghostSource = 'latest';
  await renderViews(); await refreshGhost();
  if(!rimOf(shot)){
    say(`${savedMsg(downloaded)} No rim taps, so this one won't be compared. You can add them later in the Log.`);
  }else if(prev){
    say(savedMsg(downloaded));
    await openCompare(prev, shot);
  }else{
    say(`${savedMsg(downloaded)} Next time, the app will line the photos up by the pot and show the change.`);
  }
}
const hhmm = ts => { const d = new Date(ts); const p = n => String(n).padStart(2,'0'); return p(d.getHours()) + p(d.getMinutes()); };
// 파일 이름에 시각(HHMM)까지 넣는다. 날짜만 쓰면 같은 컷을 하루에 두 번 찍을 때 이름이 겹쳐
// 안드로이드 크롬이 "Download file again?"을 묻는다(2026-09-17 실사용).
const shotFileName = s => `${slug(plantName())}-${shotView(s)}-${s.date}-${hhmm(s.ts)}.jpg`;
const savedMsg = dl => dl ? 'Saved and downloaded.' : 'Saved in this app.';
function download(blob, name){
  const u = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = u; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(u), 10000);
}

// ── 지난 사진과 비교 — 이 앱의 존재 이유 ──────────────────────────
// 두 사진의 테두리 두 점을 겹치는 변환(크기·회전·이동)을 구해 지난 사진을 지금 사진 좌표로 옮긴다.
// 거리가 달랐어도 화분이 같은 크기·같은 자리에 오므로, 달라진 건 식물뿐이다.
// 각도(위에서/옆에서)만은 2D 변환으로 못 맞춘다 — 안내문으로 두고 강제하지 않는다.
function rimTransform(from, to){                // from/to: {l, r} (0~1)
  const [fl, fr, tl, tr] = [from.l, from.r, to.l, to.r].map(toPx);
  const fv = [fr[0]-fl[0], fr[1]-fl[1]], tv = [tr[0]-tl[0], tr[1]-tl[1]];
  const flen = Math.hypot(...fv), tlen = Math.hypot(...tv);
  if(flen < 10 || tlen < 10) return null;
  return {
    scale: tlen / flen,
    angle: Math.atan2(tv[1], tv[0]) - Math.atan2(fv[1], fv[0]),
    fromMid: [(fl[0]+fr[0])/2, (fl[1]+fr[1])/2],
    toMid:   [(tl[0]+tr[0])/2, (tl[1]+tr[1])/2],
  };
}
// ── 각도 보정(호모그래피) ─────────────────────────────────────────
// 사용자 요청(2026-09-21): "각도가 달라도 사진을 보정해서 최대한 비슷하게 만들어 달라."
// 사진 한 장에는 보이는 면만 있으므로 진짜 다른 각도는 만들 수 없다. 할 수 있는 최대치는
// **화분 테두리가 놓인 평면**을 기준으로 원근을 펴는 것 — 평면 위의 점 4개가 있으면 두 사진 사이의
// 사영 변환(호모그래피, 3×3 행렬)이 유일하게 정해진다. 테두리와 바닥은 정확히 맞고, 식물처럼 그 평면
// 위로 솟은 것은 평면 가정에 따라 기울어 그려진다. 생성형으로 없는 면을 지어내는 방식은 뺐다 —
// 성장을 재는 도구에 지어낸 잎이 들어가면 재는 의미가 없다.
function solveHomography(src, dst){          // src/dst: [[x,y]×4] (픽셀). src→dst
  const A = [], b = [];
  for(let i = 0; i < 4; i++){
    const [x, y] = src[i], [u, v] = dst[i];
    A.push([x, y, 1, 0, 0, 0, -u*x, -u*y]); b.push(u);
    A.push([0, 0, 0, x, y, 1, -v*x, -v*y]); b.push(v);
  }
  // 8×8 가우스 소거(부분 피벗). 라이브러리 없이 20줄이면 된다.
  const n = 8;
  for(let c = 0; c < n; c++){
    let p = c;
    for(let r = c + 1; r < n; r++) if(Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    if(Math.abs(A[p][c]) < 1e-9) return null;    // 네 점이 한 줄에 있으면 못 푼다
    [A[c], A[p]] = [A[p], A[c]]; [b[c], b[p]] = [b[p], b[c]];
    for(let r = 0; r < n; r++){
      if(r === c) continue;
      const f = A[r][c] / A[c][c];
      for(let k = c; k < n; k++) A[r][k] -= f * A[c][k];
      b[r] -= f * b[c];
    }
  }
  const h = b.map((v, i) => v / A[i][i]);
  return [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1];
}
// 출력 화소마다 원본 좌표를 역으로 구해 양선형 보간. 1280×1600이면 200만 화소 — 폰에서 0.5초 안팎.
function warpHomography(srcData, H){          // H: dst→src
  const W = TARGET_W, Hh = TARGET_H, s = srcData.data, out = new Uint8ClampedArray(W * Hh * 4);
  const [a, b, c, d, e, f, g, h] = H;
  for(let v = 0; v < Hh; v++){
    for(let u = 0; u < W; u++){
      const w = g*u + h*v + 1;
      const x = (a*u + b*v + c) / w, y = (d*u + e*v + f) / w;
      const o = (v * W + u) * 4;
      if(x < 0 || y < 0 || x >= W - 1 || y >= Hh - 1){ out[o+3] = 255; continue; }   // 밖은 검정
      const x0 = x | 0, y0 = y | 0, fx = x - x0, fy = y - y0;
      const i00 = (y0 * W + x0) * 4, i10 = i00 + 4, i01 = i00 + W * 4, i11 = i01 + 4;
      for(let k = 0; k < 3; k++){
        out[o+k] = (s[i00+k] * (1-fx) + s[i10+k] * fx) * (1-fy) + (s[i01+k] * (1-fx) + s[i11+k] * fx) * fy;
      }
      out[o+3] = 255;
    }
  }
  return new ImageData(out, W, Hh);
}
// srcShot의 사진을 dstShot의 화면 좌표로 옮긴다. 둘 다 4점이 있으면 호모그래피, 아니면 닮음 변환(2점).
async function warpBlob(srcShot, dstShot){
  const bmp = await createImageBitmap(srcShot.blob);
  const c = document.createElement('canvas'); c.width = TARGET_W; c.height = TARGET_H;
  const ctx = c.getContext('2d');
  const qs = quadOf(srcShot), qd = quadOf(dstShot);
  let mode = 'sim';
  if(qs && qd){
    const H = solveHomography(qd.map(toPx), qs.map(toPx));       // dst→src 방향으로 바로 푼다(역행렬 불필요)
    if(H){
      ctx.drawImage(bmp, 0, 0);
      const src = ctx.getImageData(0, 0, TARGET_W, TARGET_H);
      ctx.putImageData(warpHomography(src, H), 0, 0);
      mode = 'h';
    }
  }
  if(mode === 'sim'){
    const T = rimTransform(rimOf(srcShot), rimOf(dstShot));
    if(!T){ bmp.close && bmp.close(); return null; }
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, c.width, c.height);
    ctx.imageSmoothingQuality = 'high';
    ctx.translate(T.toMid[0], T.toMid[1]); ctx.rotate(T.angle); ctx.scale(T.scale, T.scale);
    ctx.translate(-T.fromMid[0], -T.fromMid[1]);
    ctx.drawImage(bmp, 0, 0);
  }
  bmp.close && bmp.close();
  const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.9));
  return {blob, mode};
}
const alignedBlob = async (thenShot, nowShot) => { const r = await warpBlob(thenShot, nowShot); return r && r.blob; };
function growthText(thenShot, nowShot, potCm){
  const a = heightOf(thenShot, potCm), b = heightOf(nowShot, potCm);
  const days = daysBetween(thenShot.ts, nowShot.ts);
  const span = days === 0 ? 'today' : `${days} day${days === 1 ? '' : 's'}`;
  if(!a || !b) return `${span} apart. Tap the plant top on both photos to get a height change.`;
  if(a.cm != null && b.cm != null){
    const d = Math.round((b.cm - a.cm) * 10) / 10;
    return `${d >= 0 ? '+' : ''}${d} cm in ${span} (${a.cm} → ${b.cm} cm).`;
  }
  const pct = Math.round((b.ratio / a.ratio - 1) * 100);
  return `${pct >= 0 ? '+' : ''}${pct}% taller in ${span}. Set the pot size in the Log to see cm.`;
}
async function openCompare(thenShot, nowShot){
  state.compareUrls.forEach(dropURL); state.compareUrls = [];
  el.compareInfo.textContent = 'Lining the photos up…';
  const w = await warpBlob(thenShot, nowShot);
  if(!w){ say("Couldn't line the photos up — the rim taps are too close together.", true); return; }
  state.cmp = {thenShot, nowShot, mode: w.mode};
  const nowUrl = objURL(nowShot.blob), thenUrl = objURL(w.blob);
  state.compareUrls.push(nowUrl, thenUrl);
  el.compareNow.src = nowUrl; el.compareThen.src = thenUrl;
  await Promise.all([el.compareNow.decode().catch(() => {}), el.compareThen.decode().catch(() => {})]);
  el.labelThen.textContent = thenShot.date; el.labelNow.textContent = nowShot.date;
  el.compareInfo.textContent = growthText(thenShot, nowShot, (plant() || {}).potCm) +
    (w.mode === 'h' ? ' Angle corrected from the pot rim (4 taps each).' : ' Matched by size and position.');
  el.angleBtn.textContent = w.mode === 'h' ? 'Angle: corrected' : 'Fix angle (2 more taps)';
  el.angleBtn.classList.toggle('on', w.mode === 'h');
  el.compareTitle.textContent = `${plantName()} · then vs now`;
  el.wipe.value = 50; applyWipe();
  el.compare.hidden = false;
}
// 각도 보정: 두 사진 모두 앞·뒤 테두리 점이 있어야 한다. 없는 쪽부터 차례로 받는다.
async function fixAngle(){
  const c = state.cmp; if(!c || c.mode === 'h') return;
  closeCompare();
  let thenShot = c.thenShot, nowShot = c.nowShot;
  if(!quadOf(thenShot)){ thenShot = await measureQuad(thenShot); if(!thenShot) return; }
  if(!quadOf(nowShot)){ nowShot = await measureQuad(nowShot); if(!nowShot) return; }
  await openCompare(thenShot, nowShot);
}
// 지금 사진을 지난 사진의 화면으로 옮긴 JPEG. 사용자가 원한 "2번을 1번에 맞춘 사진".
async function downloadAligned(){
  const c = state.cmp; if(!c) return;
  el.alignedBtn.disabled = true;
  try{
    const w = await warpBlob(c.nowShot, c.thenShot);
    if(w) await shareShot(w.blob, `${slug(plantName())}-${c.nowShot.date}-as-${c.thenShot.date}.jpg`);
  }finally{ el.alignedBtn.disabled = false; }
}
function applyWipe(){
  const v = +el.wipe.value;
  if(el.compareThen.classList.contains('fade')){
    el.compareThen.style.clipPath = ''; el.compareThen.style.opacity = (100 - v) / 100;
    el.wipeLine.hidden = true;
  }else{
    // 지난 사진(then)이 왼쪽, 지금(now)이 오른쪽. 선을 끌면 갈리는 자리가 움직인다.
    el.compareThen.style.opacity = ''; el.compareThen.style.clipPath = `inset(0 ${100 - v}% 0 0)`;
    el.wipeLine.style.left = v + '%'; el.wipeLine.hidden = false;
  }
}
function closeCompare(){
  el.compare.hidden = true;
  state.compareUrls.forEach(dropURL); state.compareUrls = [];
}
// 앞·뒤 테두리 점 두 개를 받는다. 저장하면 갱신된 사진 레코드로, 취소하면 null로 끝난다.
function measureQuad(shot){
  return new Promise(resolve => {
    const m = rimOf(shot);
    state.measuring = {shot, mode:'quad', pts:[m.l, m.r].concat(isPt(m.f) ? [m.f] : [], isPt(m.b) ? [m.b] : []), url: objURL(shot.blob), resolve};
    el.measureImg.src = state.measuring.url;
    el.measureTitle.textContent = `Fix angle · ${shot.date}`;
    el.measure.hidden = false;
    renderMeasure();
  });
}

// ── 지난 사진 재측정 ──────────────────────────────────────────────
async function openMeasure(shot){
  const m = rimOf(shot);
  state.measuring = {shot, pts: m ? [m.l, m.r].concat(m.t ? [m.t] : []) : [], url: objURL(shot.blob)};
  el.measureImg.src = state.measuring.url;
  el.measureTitle.textContent = `Mark rim · ${shot.date}`;
  el.measure.hidden = false;
  renderMeasure();
}
function renderMeasure(){
  const m = state.measuring; if(!m) return;
  if(m.mode === 'quad'){
    drawQuad(el.measureSvg, m.pts);
    el.measureUndo.disabled = m.pts.length <= 2;          // 좌우 끝은 이미 있는 것. 앞·뒤만 되돌린다
    el.measureSave.disabled = m.pts.length < 4;
    el.measureHint.textContent = m.pts.length < 4 ? QUAD_STEPS[m.pts.length - 2] : 'Save, or undo to re-tap.';
    return;
  }
  drawTaps(el.measureSvg, m.pts, (plant() || {}).potCm);
  el.measureUndo.disabled = !m.pts.length;
  el.measureSave.disabled = m.pts.length < 2;
  el.measureHint.textContent = m.pts.length < 3 ? RIM_STEPS[m.pts.length] : 'Save, or undo to re-tap.';
}
function measureTap(ev){
  const m = state.measuring; if(!m) return;
  if(m.pts.length >= (m.mode === 'quad' ? 4 : 3)) return;
  ev.preventDefault();
  const q = tapAt(ev, el.measureStage); if(!q) return;
  m.pts.push(q);
  renderMeasure();
}
function closeMeasure(result){
  const m = state.measuring;
  if(m){ dropURL(m.url); if(m.resolve) m.resolve(result || null); }
  state.measuring = null; el.measure.hidden = true;
}
async function saveMeasure(){
  const m = state.measuring; if(!m) return;
  let shot;
  if(m.mode === 'quad'){
    if(m.pts.length < 4) return;
    shot = Object.assign({}, m.shot, {measure: Object.assign({}, m.shot.measure, {f: m.pts[2], b: m.pts[3]})});
  }else{
    if(m.pts.length < 2) return;
    // 좌우 끝을 다시 찍으면 앞·뒤 점은 뜻이 없어지므로 함께 지운다
    shot = Object.assign({}, m.shot, {measure: measureOf(m.pts)});
  }
  await dbPut('shots', shot);
  const quad = m.mode === 'quad';
  closeMeasure(shot);
  if(!quad) await openGallery();
}
// 식물 이름 바꾸기(2026-09-25 사용자 요청). 옛 백업을 가져오면 이름이 폴더 이름(`pinkprincess`)으로 붙는다.
// 이름은 화면과 내보내기 파일 이름에만 쓰이고, 사진은 식물 id로 묶여 있어 바꿔도 사진·비교는 그대로다.
// 다른 식물과 이름이 겹치면 막는다 — 목록에서 구분이 안 되고, 내보내기 폴더도 섞인다.
async function renamePlant(){
  const p = plant(); if(!p) return;
  const v = prompt('New name for this plant', p.name);
  if(v === null) return;
  const name = v.trim();
  if(!name || name === p.name) return;
  if(state.plants.some(o => o.id !== p.id && o.name.toLowerCase() === name.toLowerCase())){
    el.storageInfo.textContent = `There's already a plant called "${name}".`; return;
  }
  p.name = name;
  await dbPut('plants', p);
  renderPlants();
  await openGallery();
  el.storageInfo.textContent = `Renamed to "${name}".`;
}
async function askPotCm(){
  const p = plant(); if(!p) return;
  const v = prompt('Pot rim diameter in cm — measure it once with a ruler. Leave empty to clear.', p.potCm ? String(p.potCm) : '');
  if(v === null) return;
  const n = parseFloat(v);
  if(v.trim() === ''){ delete p.potCm; }
  else if(!(n > 0)){ el.storageInfo.textContent = 'Pot size must be a number in cm.'; return; }
  else p.potCm = n;
  await dbPut('plants', p);
  await openGallery();
}
// 갤러리 맨 위의 성장 그래프. 라이브러리 없이 SVG 한 줄. cm가 있으면 cm, 없으면 화분 폭 대비 배수.
function renderGrowth(list, potCm){
  const pts = list.map(s => ({s, h: heightOf(s, potCm)})).filter(x => x.h).sort((a, b) => a.s.ts - b.s.ts);
  if(!pts.length){ el.growth.hidden = true; return; }
  const val = x => potCm ? x.h.cm : x.h.ratio;
  const unit = potCm ? ' cm' : '× pot';
  const W = 600, H = 90, padL = 44, padR = 10, padT = 12, padB = 18;
  const t0 = pts[0].s.ts, t1 = pts[pts.length-1].s.ts || 1;
  const vs = pts.map(val);
  let lo = Math.min(...vs), hi = Math.max(...vs);
  const minSpan = potCm ? 1 : 0.2;
  if(hi - lo < minSpan){ lo -= minSpan/2; hi += minSpan/2; }
  const X = x => pts.length === 1 ? W/2 : padL + (x.s.ts - t0) / (t1 - t0) * (W - padL - padR);
  const Y = v => padT + (hi - v) / (hi - lo) * (H - padT - padB);
  const first = pts[0], last = pts[pts.length-1];
  const fmt = v => potCm ? v : v.toFixed(2);
  const delta = pts.length > 1 ? (potCm ? Math.round((val(last) - val(first)) * 10) / 10 : Math.round((val(last)/val(first) - 1) * 100)) : null;
  el.growth.innerHTML =
    `<p class="sum">Latest <b>${fmt(val(last))}${unit}</b> on ${last.s.date}` +
    (delta !== null ? ` · ${delta >= 0 ? '+' : ''}${delta}${potCm ? ' cm' : '%'} since ${first.s.date}` : '') +
    ` · ${pts.length} measured</p>` +
    `<svg viewBox="0 0 ${W} ${H}">` +
    `<text x="0" y="${padT+4}">${fmt(hi)}</text><text x="0" y="${H-padB}">${fmt(lo)}</text>` +
    (pts.length > 1 ? `<polyline points="${pts.map(x => `${X(x)},${Y(val(x))}`).join(' ')}"/>` : '') +
    pts.map(x => `<circle cx="${X(x)}" cy="${Y(val(x))}" r="3"/>`).join('') +
    `<text x="${padL}" y="${H-2}">${first.s.date}</text>` +
    (pts.length > 1 ? `<text x="${W-padR}" y="${H-2}" text-anchor="end">${last.s.date}</text>` : '') +
    `</svg>`;
  el.growth.hidden = false;
}

// ── 전체 내보내기 (ZIP) ───────────────────────────────────────────
// 사진이 브라우저 안에만 있다는 결정의 대가는, 사용자가 브라우저 데이터를 지우면
// 몇 달치 기록이 한 번에 사라진다는 것이다. **꺼낼 길이 없으면 남에게 열 수 없다.**
//
// ZIP을 압축 없이(STORE) 직접 만든다. JPEG은 이미 압축돼 있어 deflate를 걸어도 거의
// 줄지 않으므로, 압축 라이브러리를 넣어 '의존성 0개'를 깨뜨릴 이유가 없다.
// 파일을 하나씩 연속 다운로드하는 방법도 있었지만, 브라우저가 두 번째부터 차단한다.
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for(let i = 0; i < 256; i++){
    let c = i;
    for(let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[i] = c >>> 0;
  }
  return t;
})();
function crc32(u8){
  let c = 0xFFFFFFFF;
  for(let i = 0; i < u8.length; i++) c = CRC_TABLE[(c ^ u8[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
// ZIP은 1980년 기준의 DOS 시각 형식을 쓴다. 초는 2초 단위라 절반으로 접는다.
const dosTime = d => ((d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1)) & 0xFFFF;
const dosDate = d => (((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xFFFF;

async function makeZip(entries){          // entries: [{name, blob, date}]
  const enc = new TextEncoder();
  const parts = [], central = [];
  let offset = 0;
  for(const e of entries){
    const nameBytes = enc.encode(e.name);
    const data = new Uint8Array(await e.blob.arrayBuffer());
    const crc = crc32(data), t = dosTime(e.date), d = dosDate(e.date);

    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true);    // 로컬 헤더 서명
    lh.setUint16(4, 20, true);            // 필요 버전 2.0
    lh.setUint16(6, 0x0800, true);        // bit 11 — 파일 이름이 UTF-8(한글 이름 대비)
    lh.setUint16(8, 0, true);             // method 0 = 무압축
    lh.setUint16(10, t, true); lh.setUint16(12, d, true);
    lh.setUint32(14, crc, true);
    lh.setUint32(18, data.length, true);  // 압축 크기 = 원본 크기(무압축이므로)
    lh.setUint32(22, data.length, true);
    lh.setUint16(26, nameBytes.length, true);
    parts.push(new Uint8Array(lh.buffer), nameBytes, data);

    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true);    // 중앙 디렉터리 서명
    ch.setUint16(4, 20, true); ch.setUint16(6, 20, true);
    ch.setUint16(8, 0x0800, true); ch.setUint16(10, 0, true);
    ch.setUint16(12, t, true); ch.setUint16(14, d, true);
    ch.setUint32(16, crc, true);
    ch.setUint32(20, data.length, true);
    ch.setUint32(24, data.length, true);
    ch.setUint16(28, nameBytes.length, true);
    ch.setUint32(42, offset, true);       // 이 파일의 로컬 헤더 위치
    central.push(new Uint8Array(ch.buffer), nameBytes);
    offset += 30 + nameBytes.length + data.length;
  }
  const centralSize = central.reduce((n, c) => n + c.length, 0);
  const eo = new DataView(new ArrayBuffer(22));
  eo.setUint32(0, 0x06054b50, true);      // 끝 레코드(EOCD)
  eo.setUint16(8, entries.length, true);
  eo.setUint16(10, entries.length, true);
  eo.setUint32(12, centralSize, true);
  eo.setUint32(16, offset, true);
  return new Blob([...parts, ...central, new Uint8Array(eo.buffer)], {type:'application/zip'});
}

// 식물 하나가 아니라 **전부** 내보낸다. 목적이 백업이기 때문이다.
async function exportAll(){
  const shots = await dbGetAll('shots');
  if(!shots.length){ say('Nothing to export yet.', true); return; }
  // 이름이 달라도 slug가 같아질 수 있다('Monstera #1'과 'Monstera 1'). 백업에서
  // 두 식물이 한 폴더에 섞이면 같은 날짜의 사진이 서로를 덮어쓴다. 뒤엣것에 번호를 붙인다.
  const nameOf = {}, used = new Set();
  for(const p of state.plants){
    const base = slug(p.name);
    let n = base, i = 2;
    while(used.has(n)) n = `${base}-${i++}`;
    used.add(n); nameOf[p.id] = n;
  }
  el.exportAll.disabled = true;
  el.exportAll.textContent = 'Exporting…';
  try{
    const seen = new Set();
    const entries = shots
      .sort((a, b) => a.ts - b.ts)
      .map(sh => {
        const folder = nameOf[sh.plantId] || 'unknown';
        let name = `${folder}/${folder}-${shotView(sh)}-${sh.date}`, i = 2;
        while(seen.has(name)) name = `${folder}/${folder}-${shotView(sh)}-${sh.date}-${i++}`;
        seen.add(name);
        sh._file = name + '.jpg';
        return {name:name + '.jpg', blob:sh.blob, date:new Date(sh.ts)};
      });
    // 사진만 담으면 테두리 탭·기울기·컷·화분 지름이 빠져, 다른 주소나 기기로 옮기면 비교·키 재기를 다시 해야 한다.
    // 그래서 메타데이터를 JSON 한 장으로 같이 넣는다. 가져오기가 이것을 읽는다(없으면 사진만 가져온다).
    const meta = {app:'sprout-frame', format:1, exported:new Date().toISOString(),
      plants: state.plants.map(p => ({id:p.id, name:p.name, createdAt:p.createdAt, views:p.views, potCm:p.potCm, tag:p.tag, folder:nameOf[p.id]})),
      shots: shots.map(s => ({file:s._file, plantId:s.plantId, view:s.view, ts:s.ts, date:s.date, w:s.w, h:s.h, tilt:s.tilt, measure:s.measure}))};
    shots.forEach(s => delete s._file);
    entries.push({name:'sproutframe.json', blob:new Blob([JSON.stringify(meta, null, 1)], {type:'application/json'}), date:new Date()});
    const zip = await makeZip(entries);
    download(zip, `sproutframe-backup-${today()}.zip`);
    const n = entries.length - 1;
    say(`Exported ${n} photo${n === 1 ? '' : 's'} as one ZIP (${(zip.size / 1048576).toFixed(1)}MB).`);
  }catch(err){
    say(`Export failed: ${err.name}. With many photos the browser may run out of memory.`, true);
  }finally{
    el.exportAll.disabled = false;
    el.exportAll.textContent = 'Export all (ZIP)';
  }
}

// ── 가져오기 (ZIP) ────────────────────────────────────────────────
// 내보낸 ZIP을 다시 넣는다. 주소를 옮기거나(2026-09-24 Cloudflare → GitHub Pages) 폰을 바꿀 때 필요하다.
// 사진은 주소(오리진)마다 따로 저장되므로, 내보내기만 있고 가져오기가 없으면 이사가 반쪽이었다.
// - sproutframe.json이 있으면(v36 이후 내보내기) 식물·컷·화분 지름·테두리 탭·기울기까지 되살린다.
// - 없으면(옛 내보내기) 파일 이름 `폴더/폴더-컷-날짜(-시각).jpg` 또는 `폴더/폴더-날짜.jpg`에서 식물과 날짜만 읽는다.
//   테두리 탭은 Log의 Tap rim으로 다시 하면 된다.
// - 같은 식물·같은 시각(없으면 같은 날짜+같은 크기)의 사진이 이미 있으면 건너뛴다 — 두 번 가져와도 겹치지 않게.
// ZIP 해석은 직접 한다. 우리 내보내기는 무압축(STORE)이고, 사용자가 다시 압축한 ZIP(deflate)은 브라우저 내장
// DecompressionStream으로 푼다. 라이브러리를 들이지 않는다(의존성 0개).
async function readZip(file){
  const buf = new Uint8Array(await file.arrayBuffer()), dv = new DataView(buf.buffer);
  let eocd = -1;
  for(let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--){ if(dv.getUint32(i, true) === 0x06054b50){ eocd = i; break; } }
  if(eocd < 0) throw new Error('Not a ZIP file');
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const dec = new TextDecoder(), out = [];
  for(let k = 0; k < count; k++){
    if(dv.getUint32(p, true) !== 0x02014b50) throw new Error('Broken ZIP directory');
    const method = dv.getUint16(p + 10, true), csize = dv.getUint32(p + 20, true);
    const dt = dv.getUint16(p + 12, true), dd = dv.getUint16(p + 14, true);   // DOS 시각·날짜 — 내보내기가 촬영 시각을 넣어 둔다
    const mtime = new Date(1980 + (dd >> 9), ((dd >> 5) & 15) - 1, dd & 31, dt >> 11, (dt >> 5) & 63, (dt & 31) * 2).getTime();
    const nlen = dv.getUint16(p + 28, true), xlen = dv.getUint16(p + 30, true), clen = dv.getUint16(p + 32, true);
    const local = dv.getUint32(p + 42, true);
    const name = dec.decode(buf.subarray(p + 46, p + 46 + nlen));
    p += 46 + nlen + xlen + clen;
    if(name.endsWith('/')) continue;
    const lstart = local + 30 + dv.getUint16(local + 26, true) + dv.getUint16(local + 28, true);
    const raw = buf.subarray(lstart, lstart + csize);
    let data;
    if(method === 0) data = raw;
    else if(method === 8) data = new Uint8Array(await new Response(new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer());
    else continue;
    out.push({name, data, mtime});
  }
  return out;
}
async function importZip(file){
  el.importBtn.disabled = true; el.importBtn.textContent = 'Importing…';
  try{
    const files = await readZip(file);
    const metaFile = files.find(f => f.name.split('/').pop() === 'sproutframe.json');
    const meta = metaFile ? JSON.parse(new TextDecoder().decode(metaFile.data)) : null;
    const existing = await dbGetAll('shots');
    const plantsByName = new Map(state.plants.map(p => [p.name, p]));
    const plantsBySlug = new Map(state.plants.map(p => [slug(p.name), p]));
    const idMap = {};                 // 내보낸 식물 id → 여기 식물
    const ensurePlant = async (name, extra) => {
      let p = plantsByName.get(name) || plantsBySlug.get(slug(name));
      if(!p){
        p = {id:uid(), name, createdAt:Date.now()};
        state.plants.push(p); plantsByName.set(name, p); plantsBySlug.set(slug(name), p);
      }
      if(extra){
        if(extra.views && !p.views) p.views = extra.views;
        if(extra.potCm && !p.potCm) p.potCm = extra.potCm;
        // 태그가 같이 와야 옮긴 기기에서도 이미 붙인 QR 라벨이 먹는다. 이미 다른 식물이 쓰는 태그면 받지 않는다.
        if(extra.tag && !p.tag && !state.plants.some(o => o.tag === extra.tag)) p.tag = extra.tag;
      }
      await dbPut('plants', p);
      return p;
    };
    let added = 0, skipped = 0;
    const byFile = new Map(files.map(f => [f.name, f]));
    const jobs = [];
    if(meta){
      for(const mp of meta.plants || []) idMap[mp.id] = await ensurePlant(mp.name, mp);
      for(const ms of meta.shots || []){
        const f = byFile.get(ms.file); const p = idMap[ms.plantId];
        if(f && p) jobs.push({p, f, rec:ms});
      }
    }else{
      for(const f of files){
        if(!/\.jpe?g$/i.test(f.name)) continue;
        const parts = f.name.split('/'), folder = parts.length > 1 ? parts[0] : 'imported';
        const m = parts.pop().match(/(\d{4}-\d{2}-\d{2})(?:-(\d{2})(\d{2}))?(?:-\d+)?\.jpe?g$/i);
        if(!m) continue;
        const [y, mo, d] = m[1].split('-').map(Number);
        // 시각: 파일 이름에 있으면 그것, 없으면 ZIP에 기록된 파일 시각(같은 날짜일 때만), 그것도 없으면 정오.
        // 처음엔 이름에 시각이 없으면 모두 정오로 잡아, 같은 날 찍은 사진들이 서로를 "중복"으로 지웠다(검증 중 발견).
        const zd = new Date(f.mtime);
        const zipSameDay = zd.getFullYear() === y && zd.getMonth() === mo - 1 && zd.getDate() === d;
        const ts = m[2] ? new Date(y, mo - 1, d, +m[2], +m[3]).getTime()
                 : zipSameDay ? f.mtime : new Date(y, mo - 1, d, 12).getTime();
        const p = await ensurePlant(folder);
        const base = parts.length ? f.name.split('/').pop() : f.name;
        const rest = base.replace(folder + '-', '').replace(/-?\d{4}-\d{2}-\d{2}.*$/, '');
        const view = viewsOf(p).some(v => v.id === rest) ? rest : LEGACY_VIEW;
        jobs.push({p, f, rec:{ts, date:m[1], view, w:TARGET_W, h:TARGET_H}});
      }
    }
    for(const {p, f, rec} of jobs){
      // 중복 판정: 메타가 있으면 촬영 시각(ts)으로, 없으면 날짜 + 파일 크기로(시각은 추정값일 수 있으므로).
      const dup = existing.some(s => s.plantId === p.id &&
        (meta ? s.ts === rec.ts : (s.date === rec.date && s.blob.size === f.data.length && Math.abs(s.ts - rec.ts) < 60000)));
      if(dup){ skipped++; continue; }
      const shot = {id:uid(), plantId:p.id, view:rec.view || LEGACY_VIEW, ts:rec.ts, date:rec.date,
        w:rec.w || TARGET_W, h:rec.h || TARGET_H, blob:new Blob([f.data], {type:'image/jpeg'}),
        tilt:rec.tilt, measure:rec.measure};
      await dbPut('shots', shot); existing.push(shot); added++;
    }
    state.plants.sort((a, b) => a.createdAt - b.createdAt);
    if(!state.plantId && state.plants.length) state.plantId = state.plants[0].id;
    renderPlants(); await renderViews(); await refreshGhost();
    el.storageInfo.textContent = `Imported ${added} photo${added === 1 ? '' : 's'}` +
      (skipped ? `, skipped ${skipped} already here` : '') +
      (meta ? '.' : '. Old backup without details — use Tap rim on each photo to compare again.');
    await openGallery();
    el.storageInfo.textContent = `Imported ${added}` + (skipped ? `, skipped ${skipped} already here` : '') +
      (meta ? ' (with rim taps and angles).' : '. This backup had photos only — tap the rim again in the Log to compare.');
  }catch(err){
    el.storageInfo.textContent = `Import failed: ${err.message || err.name}`;
  }finally{
    el.importBtn.disabled = false; el.importBtn.textContent = 'Import (ZIP)';
  }
}

// 폰에서 찍은 사진을 PC로 옮기는 통로. 공유 시트를 열어 Dropbox 앱으로 보내면
// PC의 Dropbox 폴더에 동기화된다 — 케이블도, 계정 연동도, 서버도 필요 없다.
// 데스크톱처럼 파일 공유를 지원하지 않는 환경에서는 그냥 내려받기로 떨어진다.
async function shareShot(blob, name){
  const file = new File([blob], name, {type:'image/jpeg'});
  if(navigator.canShare && navigator.canShare({files:[file]})){
    try{ await navigator.share({files:[file], title:name}); }
    catch(err){ if(err.name !== 'AbortError') say(`Couldn't share: ${err.name}`, true); }
  }else{
    download(blob, name);
    say("This browser can't share files, so it was downloaded instead.");
  }
}

// ── 나란히 보기 (JPEG 한 장) ──────────────────────────────────────
// 같은 컷을 시간순으로 최대 4장, 처음·끝을 포함해 고르게 뽑아 한 장으로 붙인다.
// 테두리가 찍힌 사진은 **화분 폭을 같게 맞춰** 그린다 — 거리가 달랐어도 공정한 비교가 되게.
// 4장인 이유: 폰 화면 폭에서 각 장이 알아볼 크기로 남는 한계가 대략 그 정도다.
const STRIP_MAX = 4, STRIP_W = 640, STRIP_H = 800, STRIP_CAP = 56;
function pickSpread(list, n){
  if(list.length <= n) return list;
  const idx = new Set();
  for(let i = 0; i < n; i++) idx.add(Math.round(i * (list.length - 1) / (n - 1)));
  return [...idx].sort((a, b) => a - b).map(i => list[i]);
}
async function makeStrip(shots, potCm){
  const c = document.createElement('canvas');
  c.width = STRIP_W * shots.length; c.height = STRIP_H + STRIP_CAP;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#111413'; ctx.fillRect(0, 0, c.width, c.height);
  ctx.imageSmoothingQuality = 'high';
  // 기준: 첫 장의 테두리. 전부 테두리가 있으면 각 장을 첫 장의 화분 크기·자리로 옮긴다.
  const ref = shots.every(rimOf) ? rimOf(shots[0]) : null;
  const k = STRIP_W / TARGET_W;
  for(let i = 0; i < shots.length; i++){
    const bmp = await createImageBitmap(shots[i].blob);
    ctx.save();
    ctx.beginPath(); ctx.rect(i * STRIP_W, 0, STRIP_W, STRIP_H); ctx.clip();
    ctx.translate(i * STRIP_W, 0); ctx.scale(k, k);
    const T = ref && i > 0 ? rimTransform(rimOf(shots[i]), ref) : null;
    if(T){
      ctx.translate(T.toMid[0], T.toMid[1]); ctx.rotate(T.angle); ctx.scale(T.scale, T.scale);
      ctx.translate(-T.fromMid[0], -T.fromMid[1]);
    }
    ctx.drawImage(bmp, 0, 0);
    ctx.restore();
    bmp.close && bmp.close();
    ctx.fillStyle = '#e8ece9'; ctx.font = '600 26px system-ui, sans-serif'; ctx.textBaseline = 'middle';
    const h = heightOf(shots[i], potCm);
    ctx.fillText(shots[i].date + (h ? `  ·  ${fmtHeight(h)}` : ''), i * STRIP_W + 16, STRIP_H + STRIP_CAP / 2);
  }
  return new Promise(r => c.toBlob(r, 'image/jpeg', 0.9));
}
async function exportStrip(){
  const filter = state.galleryView === null ? state.viewId : state.galleryView;
  if(!filter){ el.storageInfo.textContent = 'Pick one view to make a side-by-side.'; return; }
  const list = (await shotsOf(state.plantId, filter)).sort((a, b) => a.ts - b.ts);
  if(list.length < 2){ el.storageInfo.textContent = 'Need at least two shots of this view for a side-by-side.'; return; }
  el.stripBtn.disabled = true; el.stripBtn.textContent = 'Making…';
  try{
    const picked = pickSpread(list, STRIP_MAX);
    const blob = await makeStrip(picked, (plant() || {}).potCm);
    await shareShot(blob, `${slug(plantName())}-${filter}-${picked[0].date}-to-${picked[picked.length-1].date}.jpg`);
  }catch(err){
    el.storageInfo.textContent = `Couldn't make the side-by-side: ${err.name}.`;
  }finally{
    el.stripBtn.disabled = false; el.stripBtn.textContent = 'Side by side (JPEG)';
  }
}

// ── 기록(갤러리) ──────────────────────────────────────────────────
async function openGallery(){
  const p = plant();
  el.galleryTitle.textContent = (state.plantId ? `${plantName()} · Log` : 'Log') + ` · ${self.GC_VERSION}`;
  el.autoSave.checked = localStorage.getItem('gc.autosave') !== 'no';
  el.potBtn.textContent = p && p.potCm ? `Pot: ${p.potCm} cm` : 'Pot size: not set';
  el.potBtn.hidden = !p;
  el.renameBtn.hidden = !p;
  const filter = state.galleryView === null ? state.viewId : state.galleryView;   // '' = 전부
  el.galleryViews.innerHTML = p ? [{id:'', name:'All'}, ...viewsOf(p)].map(v =>
    `<button class="chip view${filter === v.id ? ' on' : ''}" data-gview="${v.id}">${esc(v.name)}</button>`).join('') : '';
  el.galleryViews.querySelectorAll('[data-gview]').forEach(b => b.onclick = () => { state.galleryView = b.dataset.gview; openGallery(); });
  const list = await shotsOf(state.plantId, filter || null);
  // 그래프는 컷 하나를 골랐을 때만. 옆과 위에서 잰 값을 한 선에 섞으면 뜻이 없다.
  if(filter) renderGrowth(list, p && p.potCm); else el.growth.hidden = true;
  el.shots.innerHTML = '';
  if(!list.length) el.shots.innerHTML = '<p class="hint">No shots yet.</p>';
  for(const s of list){
    const url = objURL(s.blob);
    const h = heightOf(s, p && p.potCm);
    const prev = list.find(o => o.ts < s.ts && shotView(o) === shotView(s) && rimOf(o));
    const card = document.createElement('div');
    card.className = 'shot';
    card.innerHTML =
      `<img src="${url}" alt="">
       <div class="meta">${s.date} · ${esc(viewName(shotView(s)))}${h ? ` · <b>${fmtHeight(h)}</b>` : rimOf(s) ? '' : ' · <i>no rim</i>'}</div>
       <div class="acts">
         <button data-a="cmp" ${rimOf(s) && prev ? '' : 'disabled'}>Compare</button>
         <button data-a="measure">${rimOf(s) ? 'Re-tap' : 'Tap rim'}</button>
         <button data-a="ref">Ghost</button>
         <button data-a="share">Share</button>
         <button data-a="dl">Download</button>
         <button data-a="del">Delete</button>
       </div>`;
    card.querySelector('[data-a=cmp]').onclick = () => openCompare(prev, s);
    card.querySelector('[data-a=measure]').onclick = () => openMeasure(s);
    card.querySelector('[data-a=ref]').onclick = async () => {
      if(shotView(s) !== state.viewId){ state.viewId = shotView(s); await renderViews(); }
      state.ghostSource = 'pinned';         // 특정 사진을 고정 기준으로 쓴다. 기울기·테두리 정보도 그 사진 것을 쓴다
      state.pinnedShot = s;
      closeGallery();
      await refreshGhost();
    };
    card.querySelector('[data-a=share]').onclick = () => shareShot(s.blob, shotFileName(s));
    card.querySelector('[data-a=dl]').onclick = () => download(s.blob, shotFileName(s));
    card.querySelector('[data-a=del]').onclick = async () => {
      if(!confirm(`Delete the ${s.date} photo? This can't be undone.`)) return;
      await dbDel('shots', s.id); await openGallery(); await renderViews(); await refreshGhost();
    };
    el.shots.appendChild(card);
  }
  if(navigator.storage && navigator.storage.estimate){
    const {usage, quota} = await navigator.storage.estimate();
    const persisted = localStorage.getItem('gc.persisted') === 'yes';
    el.storageInfo.textContent =
      `In this browser: ${(usage/1048576).toFixed(1)}MB of about ${(quota/1073741824).toFixed(1)}GB · ` +
      (persisted ? 'persistent storage granted'
                 : 'persistent storage not granted — the browser may reclaim this space. Use Export all to keep a copy.');
  }
  el.gallery.hidden = false;
}
function closeGallery(){ el.gallery.hidden = true; }

// ── 이벤트 ────────────────────────────────────────────────────────
el.startBtn.onclick = startCamera;
el.shutter.onclick = capture;
el.opacity.oninput = applyOpacity;

el.plantBtn.onclick = openPicker;
el.addPlant.onclick = addPlant;
el.pickerClose.onclick = closePicker;
el.labelsBtn.onclick = openLabels;
el.labelsClose.onclick = () => { el.labels.hidden = true; };
el.printBtn.onclick = () => print();
window.addEventListener('hashchange', tagFromLocation);

el.modeBtn.onclick = () => {
  const diff = el.ghost.classList.toggle('difference');
  el.modeBtn.textContent = diff ? 'Mode: Difference' : 'Mode: Overlay';
  el.modeBtn.classList.toggle('on', diff);
  el.opacity.disabled = diff;
  // 차이 모드: 두 장이 정확히 겹치면 화면이 검게 죽는다. 반투명보다 어긋남이 훨씬 잘 보인다.
  say(diff ? 'Difference mode — the closer the match, the darker the view. Find the darkest spot.' : '');
};
el.gridBtn.onclick = () => {
  el.grid.hidden = !el.grid.hidden;
  const shown = !el.grid.hidden;
  el.gridBtn.textContent = shown ? 'Grid off' : 'Grid on';
  el.gridBtn.classList.toggle('on', shown);
};
el.flipBtn.onclick = async () => {
  state.facing = state.facing === 'environment' ? 'user' : 'environment';
  if(state.stream) await startCamera();
};
// 멈춘 카메라 복구용. 전에는 '카메라 전환'으로 우회해야 했는데,
// 그러면 엉뚱한 카메라로 바뀌어 기준 사진과 안 맞게 된다.
el.restartBtn.onclick = () => { say('Restarting camera…'); startCamera(); };
el.ghostBtn.onclick = () => {
  // 켜짐(지난 사진 또는 고정한 사진) → 끔 → 켜짐(지난 사진)
  state.ghostSource = state.ghostSource === 'none' ? 'latest' : 'none';
  state.pinnedShot = null;
  refreshGhost();
};

el.saveBtn.onclick = save;
el.shareBtn.onclick = () => {
  if(!state.pending) return;
  shareShot(state.pending, `${slug(plantName())}-${state.viewId}-${today()}-${hhmm(Date.now())}.jpg`);
};
el.retakeBtn.onclick = () => { state.pending = null; state.rim = []; el.review.hidden = true; };
el.reviewLayer.addEventListener('touchstart', rimTap, {passive:false});
el.reviewLayer.addEventListener('mousedown', rimTap);
el.rimUndo.onclick = () => { state.rim.pop(); drawRim(); };
const showGhostInReview = on => { el.reviewGhost.hidden = !on; };
['mousedown','touchstart'].forEach(e =>
  el.compareBtn.addEventListener(e, ev => { ev.preventDefault(); showGhostInReview(true); }));
['mouseup','mouseleave','touchend','touchcancel'].forEach(e =>
  el.compareBtn.addEventListener(e, () => showGhostInReview(false)));

el.wipe.oninput = applyWipe;
el.compareMode.onclick = () => {
  const fade = el.compareThen.classList.toggle('fade');
  el.compareMode.textContent = fade ? 'Mode: Fade' : 'Mode: Wipe';
  applyWipe();
};
el.compareClose.onclick = closeCompare;

el.measureLayer.addEventListener('touchstart', measureTap, {passive:false});
el.measureLayer.addEventListener('mousedown', measureTap);
el.measureUndo.onclick = () => { const m = state.measuring; if(m && m.pts.length > (m.mode === 'quad' ? 2 : 0)){ m.pts.pop(); renderMeasure(); } };
el.measureSave.onclick = saveMeasure;
el.measureClose.onclick = () => closeMeasure(null);
el.angleBtn.onclick = fixAngle;
el.alignedBtn.onclick = downloadAligned;
el.potBtn.onclick = askPotCm;
el.renameBtn.onclick = renamePlant;

const renderAutoBtn = () => {
  const on = localStorage.getItem('gc.autoshoot') !== 'no';
  el.autoBtn.textContent = on ? 'Auto-shoot: on' : 'Auto-shoot: off';
  el.autoBtn.classList.toggle('on', on);
};
el.autoBtn.onclick = () => {
  localStorage.setItem('gc.autoshoot', localStorage.getItem('gc.autoshoot') === 'no' ? 'yes' : 'no');
  renderAutoBtn();
};
el.moreBtn.onclick = () => {
  el.adv.hidden = !el.adv.hidden;
  el.moreBtn.textContent = el.adv.hidden ? 'More tools ▾' : 'Fewer tools ▴';
  localStorage.setItem('gc.more', el.adv.hidden ? 'no' : 'yes');
  renderViews();
};
el.galleryBtn.onclick = openGallery;
el.galleryClose.onclick = closeGallery;
el.exportAll.onclick = exportAll;
// 옛 주소에서 가져오면 옛 주소에 쌓일 뿐이다. 실사용에서 실제로 그렇게 됐다(2026-09-24, 홈 화면 아이콘이 옛 앱이었다).
const OLD_HOST = location.hostname.endsWith('workers.dev');
el.importBtn.onclick = () => {
  if(OLD_HOST){ el.storageInfo.textContent = 'This is the old address. Import on the new one: altair-research.github.io/sprout-frame'; return; }
  el.importFile.click();
};
el.importFile.onchange = async () => {
  const f = el.importFile.files && el.importFile.files[0];
  el.importFile.value = '';
  if(f) await importZip(f);
};
el.stripBtn.onclick = exportStrip;
el.autoSave.onchange = () => {
  localStorage.setItem('gc.autosave', el.autoSave.checked ? 'yes' : 'no');
  say(el.autoSave.checked ? 'Each shot will also be downloaded as a file.'
                          : 'Shots stay in this app. Use Share or Export all to get them out.');
};

document.addEventListener('keydown', e => {
  if(e.code === 'Space' && !el.shutter.disabled && el.review.hidden && el.gallery.hidden && el.compare.hidden){
    e.preventDefault(); capture();
  }
  if(e.key === 'Escape'){
    if(state.measuring) closeMeasure(null);
    else if(!el.compare.hidden) closeCompare();
    else if(!el.labels.hidden) el.labels.hidden = true;
    else if(!el.picker.hidden) closePicker();
    else { closeGallery(); el.review.hidden = true; }
  }
});
window.addEventListener('pagehide', stopCamera);

// ── 오프라인 실행 ─────────────────────────────────────────────────
// 서비스 워커는 앱 껍데기만 캐시한다. 사진은 IndexedDB에 있으므로 여기 관여하지 않는다.
// 부수 효과: 설치형(홈 화면 추가)이 되면 브라우저가 저장 공간을 회수할 확률이 낮아진다.
if('serviceWorker' in navigator){
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(err => console.warn('SW 등록 실패', err));
  });
}

// ── 시작 ──────────────────────────────────────────────────────────
(async function init(){
  el.ver.textContent = self.GC_VERSION;      // 헤더에 버전. 최신인지 화면만 보고 알 수 있게
  // 2026-09-24 GitHub Pages(altair-research.github.io/ghost-cam/)로 이사. 옛 Cloudflare 주소에서는 안내를 띄운다.
  if(location.hostname.endsWith('workers.dev')) $('moved').hidden = false;
  if(matchMedia('(display-mode: standalone)').matches || navigator.standalone) $('installTip').hidden = true;
  renderAutoBtn();      // 헤더에 버전. 최신인지 화면만 보고 알 수 있게
  if(!window.isSecureContext){
    say('Not a secure context. The camera only works over https or http://localhost.', true);
  }
  if(localStorage.getItem('gc.more') === 'yes'){ el.adv.hidden = false; el.moreBtn.textContent = 'Fewer tools ▴'; }
  await loadPlants();
  // 소개글은 처음 온 사람 몫이다. 식물이 있으면 이미 아는 사람이니 버튼만 남긴다.
  if(state.plants.length){ el.intro.hidden = true; el.introHint.hidden = true; el.introPrivacy.hidden = true; }
  await refreshGhost();
  applyOpacity();
  await tagFromLocation();
})();
