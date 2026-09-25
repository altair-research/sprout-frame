// 라벨 글씨 읽기 — 화분에 붙은 라벨기 스티커(AV01, PP01, TC01a …)를 카메라로 읽는다(2026-09-25 사용자 요청).
// QR과 달리 따로 인쇄할 게 없다. 이미 모든 화분에 이 형식의 라벨이 붙어 있다(Uncommon Plant 05-plant-register).
//
// 엔진은 Tesseract.js(Apache-2.0)를 app/ocr/에 넣어 폰 안에서 돌린다. 사진이 밖으로 나가지 않고 무료다.
// **의존성 0개 원칙의 첫 예외**다(PROJECT.md §3). 대안 둘은 버렸다:
//   - 크롬 내장 TextDetector — 아직 실험 플래그 뒤에 있어 남의 폰에서 안 켜진다
//   - Claude(Haiku) — 8장 전부 읽었지만 API 키를 숨길 서버가 필요하고, 라벨 조각이라도 사진이 밖으로 나간다
// 첫 사용 때 약 7MB를 받는다. 누르기 전에는 한 바이트도 받지 않는다.
//
// 실측(2026-09-25, 아보카도 라벨 사진 8장, 저녁 조명, 라벨 둘레만 잘라서): 5장 정확, 3장 못 읽음, 오답 1회(AV06→VO06).
// 그래서 아래 세 겹으로 막는다 — 실패가 "틀린 식물"이 아니라 "못 읽음, 다시"가 되게.
//   ① 흰 라벨 덩어리를 먼저 찾아 그 안만 읽는다(흙·로고·배경이 섞이면 거의 전부 실패했다)
//   ② 한 덩어리 전체가 정확히 '대문자 2 + 숫자 2 (+소문자 1)'일 때만 코드로 본다
//   ③ 같은 코드가 두 번 나와야 인정한다

const OCR_DIR = 'ocr/';
let _worker = null, _loading = null;

function loadScript(src){
  return new Promise((res, rej) => {
    const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = () => rej(new Error('load ' + src));
    document.head.appendChild(s);
  });
}
export async function ocrWorker(onStatus){
  if(_worker) return _worker;
  if(!_loading) _loading = (async () => {
    if(!self.Tesseract) await loadScript(OCR_DIR + 'tesseract.min.js');
    const w = await self.Tesseract.createWorker('eng', 1, {
      workerPath: OCR_DIR + 'worker.min.js',
      corePath: OCR_DIR + 'tesseract-core-simd-lstm.wasm.js',   // SIMD판 하나만 둔다(요즘 크롬·사파리 전부 지원). 없는 판은 4MB라 뺐다
      langPath: OCR_DIR.replace(/\/$/, ''),
      cacheMethod: 'none',        // 라이브러리 자체 캐시(IndexedDB)는 끈다 — 서비스 워커가 같은 파일을 이미 보관한다
      workerBlobURL: false,
      logger: m => onStatus && onStatus(m),
    });
    // 7 = 한 줄로 본다. 8(한 단어)은 실측에서 거의 아무것도 못 읽었다.
    await w.setParameters({tessedit_pageseg_mode:'7', tessedit_char_whitelist:'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'});
    _worker = w; return w;
  })();
  try{ return await _loading; }catch(e){ _loading = null; throw e; }
}
export async function ocrStop(){
  // 읽기가 끝나면 워커를 내린다. 폰 메모리에서 수십 MB를 차지한다. 다시 켜는 데는 1초 안팎(파일은 캐시에 있다).
  const w = _worker; _worker = null; _loading = null;
  if(w) await w.terminate().catch(() => {});
}

// ── ① 흰 라벨 찾기 ─────────────────────────────────────────────────
// 작게 줄인 흑백에서 "그 장면에서 가장 밝은 편"인 덩어리 중 가로로 긴 직사각형.
// 밝음 기준은 97퍼센타일의 0.8배 — 저녁 조명 사진에서 라벨 밝기가 170~220으로 제각각이라 고정값이 안 됐다.
// 배경에 흰 종이가 있으면 기준이 올라가 라벨을 놓친다(av03·av04 실측) → 호출하는 쪽이 가이드 칸 안만 넘긴다.
export function findLabels(src, sw, sh){
  const SW = 320, s = SW / sw, SH = Math.max(1, Math.round(sh * s));
  const c = document.createElement('canvas'); c.width = SW; c.height = SH;
  const g = c.getContext('2d', {willReadFrequently:true});
  g.drawImage(src, 0, 0, sw, sh, 0, 0, SW, SH);
  const d = g.getImageData(0, 0, SW, SH).data, N = SW * SH, gray = new Uint8Array(N);
  for(let i = 0; i < N; i++) gray[i] = (d[i*4] * 0.299 + d[i*4+1] * 0.587 + d[i*4+2] * 0.114) | 0;
  const sorted = Uint8Array.from(gray).sort();
  const thr = Math.max(120, sorted[Math.floor(N * 0.97)] * 0.8);
  const lab = new Int32Array(N).fill(-1), boxes = [];
  for(let i = 0; i < N; i++){
    if(gray[i] < thr || lab[i] !== -1) continue;
    let x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1, n = 0;
    const st = [i]; lab[i] = boxes.length;
    while(st.length){
      const p = st.pop(); n++;
      const x = p % SW, y = (p / SW) | 0;
      if(x < x0) x0 = x; if(x > x1) x1 = x; if(y < y0) y0 = y; if(y > y1) y1 = y;
      if(x > 0 && gray[p-1] >= thr && lab[p-1] === -1){ lab[p-1] = boxes.length; st.push(p-1); }
      if(x < SW-1 && gray[p+1] >= thr && lab[p+1] === -1){ lab[p+1] = boxes.length; st.push(p+1); }
      if(y > 0 && gray[p-SW] >= thr && lab[p-SW] === -1){ lab[p-SW] = boxes.length; st.push(p-SW); }
      if(y < SH-1 && gray[p+SW] >= thr && lab[p+SW] === -1){ lab[p+SW] = boxes.length; st.push(p+SW); }
    }
    const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
    boxes.push({x:x0/s, y:y0/s, w:bw/s, h:bh/s, fill:n/(bw*bh), ar:bw/bh, n});
  }
  // 라벨다운 것: 가로가 긴 편(1.3~8), 속이 찬 편(글자 구멍이 있어 1은 아님), 너무 작지 않게, 칸을 통째로 채우지 않게
  return boxes.filter(b => b.ar > 1.3 && b.ar < 8 && b.fill > 0.5 && b.n > 60 && b.w < sw * 0.95)
              .sort((a, b) => b.n - a.n).slice(0, 3);
}

// 라벨 안쪽만 잘라 흑백 두 값으로(Otsu) 만들고 흰 여백을 둘러 준다.
// 이 전처리 전후로 8장 중 2장 → 5장이 됐다(가장자리의 어두운 테두리가 Tesseract를 가장 많이 흐트렸다).
export function prepLabel(src, b, H = 90){
  const ix = b.w * 0.04, iy = b.h * 0.08;
  const sx = b.x + ix, sy = b.y + iy, sw = b.w - 2 * ix, sh = b.h - 2 * iy;
  const W = Math.max(1, Math.round(sw * H / sh)), PAD = 24;
  const c = document.createElement('canvas'); c.width = W + 2 * PAD; c.height = H + 2 * PAD;
  const g = c.getContext('2d', {willReadFrequently:true});
  g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
  g.drawImage(src, sx, sy, sw, sh, PAD, PAD, W, H);
  const id = g.getImageData(PAD, PAD, W, H), d = id.data, n = W * H, gr = new Uint8Array(n), hist = new Array(256).fill(0);
  for(let i = 0; i < n; i++){ const v = (d[i*4] * 0.299 + d[i*4+1] * 0.587 + d[i*4+2] * 0.114) | 0; gr[i] = v; hist[v]++; }
  let sum = 0; for(let i = 0; i < 256; i++) sum += i * hist[i];
  let sB = 0, wB = 0, best = 0, thr = 128;
  for(let t = 0; t < 256; t++){
    wB += hist[t]; if(!wB) continue;
    const wF = n - wB; if(!wF) break;
    sB += t * hist[t];
    const mB = sB / wB, mF = (sum - sB) / wF, v = wB * wF * (mB - mF) ** 2;
    if(v > best){ best = v; thr = t; }
  }
  for(let i = 0; i < n; i++){ const v = gr[i] > thr ? 255 : 0; d[i*4] = d[i*4+1] = d[i*4+2] = v; }
  g.putImageData(id, PAD, PAD);
  return c;
}

// ── ② 코드 모양 ────────────────────────────────────────────────────
// 앞 두 자리는 글자, 다음 두 자리는 숫자라는 걸 알고 있으니 자리별로 헷갈리는 글자를 바로잡는다.
// 실측에서 나온 것: AVO1(→AV01) · AVOZ(→AV02) · AVOB(→AV08). 반대 방향(0→O 등)도 대칭으로 둔다.
const TO_LETTER = {'0':'O', '1':'I', '5':'S', '8':'B', '2':'Z', '6':'G'};
const TO_DIGIT  = {'O':'0', 'Q':'0', 'D':'0', 'I':'1', 'L':'1', 'Z':'2', 'S':'5', 'B':'8', 'G':'6'};
// 덩어리(공백으로 나뉜 한 조각)가 **통째로** 코드 모양일 때만. 부분 일치를 허용했더니
// 'AVO06'(0 하나를 O0로 두 번 읽음)에서 'VO06'이라는 오답이 나왔다(실측) — 그래서 덩어리 길이도 본다.
export function codeOf(text){
  for(const tok of String(text || '').split(/\s+/)){
    const m = /^([A-Za-z0-9]{2})([A-Za-z0-9]{2})([a-z]?)$/.exec(tok);
    if(!m) continue;
    const a = m[1].toUpperCase().split('').map(c => TO_LETTER[c] || c).join('');
    const d = m[2].toUpperCase().split('').map(c => TO_DIGIT[c] || c).join('');
    if(/^[A-Z]{2}$/.test(a) && /^[0-9]{2}$/.test(d)) return a + d + m[3];
  }
  return null;
}
// 식물 이름 안의 코드. 이름을 'AV01'로 짓든 'AV01 Avocado'로 짓든 찾는다.
export function codeInName(name){
  // 앞 네 자리는 대소문자를 가리지 않는다(av01로 지은 식물도 있다). 삽수 표시(a, b…)만 소문자로.
  const m = /(?:^|[^A-Za-z0-9])([A-Za-z]{2}\d{2})([a-z]?)(?![A-Za-z0-9])/.exec(' ' + (name || '') + ' ');
  return m ? m[1].toUpperCase() + m[2] : null;
}

// ── 한 장면 읽기 ───────────────────────────────────────────────────
// src 영역(가이드 칸)에서 라벨 후보를 찾아 읽고, 코드 모양이 나온 첫 결과를 돌려준다. 없으면 null.
export async function readCode(src, sw, sh){
  const w = await ocrWorker();
  for(const b of findLabels(src, sw, sh)){
    const r = await w.recognize(prepLabel(src, b));
    const code = codeOf(r.data.text);
    if(code) return {code, raw:r.data.text.trim()};
  }
  return null;
}
