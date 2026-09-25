// QR 코드 생성기 — 식물 라벨용. 의존성 0개 원칙(PROJECT.md §3) 때문에 직접 쓴다.
// 범위를 좁혀 짧게 했다: 바이트 모드 · 오류 정정 M · 버전 1~10(최대 213바이트). 라벨 내용은 60바이트 안팎이다.
// M(약 15% 복구)을 고른 이유: 화분 라벨은 흙·물에 젖고 긁힌다. L(7%)은 약하고, Q·H는 같은 내용에 칸이 커져
// 멀리서 찍을 때 오히려 안 읽힌다. 알고리즘은 ISO/IEC 18004 그대로이고, 구조는 Nayuki의 공개 구현을 참고했다.
// 검증: tools/qr-check.mjs → OpenCV QRCodeDetector로 되읽어 원문과 비교.

const ECC_PER_BLOCK = [10, 16, 26, 18, 24, 16, 18, 22, 22, 26];   // 레벨 M, 버전 1~10
const NUM_BLOCKS    = [ 1,  1,  1,  2,  2,  4,  4,  4,  5,  5];

const rawModules = v => {
  let r = (16 * v + 128) * v + 64;
  if(v >= 2){ const n = Math.floor(v / 7) + 2; r -= (25 * n - 10) * n - 55; if(v >= 7) r -= 36; }
  return r;
};
const dataCodewords = v => Math.floor(rawModules(v) / 8) - ECC_PER_BLOCK[v - 1] * NUM_BLOCKS[v - 1];

// GF(2^8) 곱셈, 다항식 0x11D
function gfMul(x, y){
  let z = 0;
  for(let i = 7; i >= 0; i--){ z = (z << 1) ^ ((z >>> 7) * 0x11D); z ^= ((y >>> i) & 1) * x; }
  return z & 0xFF;
}
function rsDivisor(deg){
  const r = new Array(deg).fill(0); r[deg - 1] = 1;
  let root = 1;
  for(let i = 0; i < deg; i++){
    for(let j = 0; j < deg; j++){ r[j] = gfMul(r[j], root); if(j + 1 < deg) r[j] ^= r[j + 1]; }
    root = gfMul(root, 2);
  }
  return r;
}
function rsRemainder(data, div){
  const r = new Array(div.length).fill(0);
  for(const b of data){
    const f = b ^ r.shift(); r.push(0);
    div.forEach((c, i) => { r[i] ^= gfMul(c, f); });
  }
  return r;
}

const MASKS = [
  (x, y) => (x + y) % 2 === 0,
  (x, y) => y % 2 === 0,
  (x, y) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => x * y % 2 + x * y % 3 === 0,
  (x, y) => (x * y % 2 + x * y % 3) % 2 === 0,
  (x, y) => ((x + y) % 2 + x * y % 3) % 2 === 0,
];

// text → {size, dark(x, y)}. 넘치면 예외.
export function qrMatrix(text){
  const bytes = [...new TextEncoder().encode(text)];
  let ver = 0;
  for(let v = 1; v <= 10; v++){
    const cc = v <= 9 ? 8 : 16;
    if(4 + cc + bytes.length * 8 <= dataCodewords(v) * 8){ ver = v; break; }
  }
  if(!ver) throw new Error('QR: text too long');
  const size = ver * 4 + 17;

  // ── 데이터 비트열 ──
  const bits = [];
  const put = (val, n) => { for(let i = n - 1; i >= 0; i--) bits.push((val >>> i) & 1); };
  put(4, 4);                                  // 바이트 모드 0100
  put(bytes.length, ver <= 9 ? 8 : 16);
  bytes.forEach(b => put(b, 8));
  const cap = dataCodewords(ver) * 8;
  put(0, Math.min(4, cap - bits.length));     // 종료 표시
  put(0, (8 - bits.length % 8) % 8);
  for(let pad = 0xEC; bits.length < cap; pad ^= 0xEC ^ 0x11) put(pad, 8);
  const data = [];
  for(let i = 0; i < bits.length; i += 8) data.push(parseInt(bits.slice(i, i + 8).join(''), 2));

  // ── 블록 나누기 + 오류 정정 + 섞기 ──
  const nb = NUM_BLOCKS[ver - 1], ecl = ECC_PER_BLOCK[ver - 1];
  const raw = Math.floor(rawModules(ver) / 8);
  const nShort = nb - raw % nb, shortLen = Math.floor(raw / nb);
  const div = rsDivisor(ecl);
  const blocks = [];
  for(let i = 0, k = 0; i < nb; i++){
    const dat = data.slice(k, k + shortLen - ecl + (i < nShort ? 0 : 1));
    k += dat.length;
    const ecc = rsRemainder(dat, div);
    if(i < nShort) dat.push(0);
    blocks.push(dat.concat(ecc));
  }
  const cw = [];
  for(let i = 0; i < blocks[0].length; i++)
    blocks.forEach((b, j) => { if(i !== shortLen - ecl || j >= nShort) cw.push(b[i]); });

  // ── 고정 무늬 ──
  const mod = Array.from({length:size}, () => new Array(size).fill(false));
  const fn  = Array.from({length:size}, () => new Array(size).fill(false));
  const set = (x, y, d) => { mod[y][x] = d; fn[y][x] = true; };
  for(let i = 0; i < size; i++){ set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }
  const finder = (cx, cy) => {
    for(let dy = -4; dy <= 4; dy++) for(let dx = -4; dx <= 4; dx++){
      const x = cx + dx, y = cy + dy, d = Math.max(Math.abs(dx), Math.abs(dy));
      if(x >= 0 && x < size && y >= 0 && y < size) set(x, y, d !== 2 && d !== 4);
    }
  };
  finder(3, 3); finder(size - 4, 3); finder(3, size - 4);
  if(ver >= 2){
    const n = Math.floor(ver / 7) + 2;
    const step = Math.floor((ver * 8 + n * 3 + 5) / (n * 4 - 4)) * 2;
    const pos = [6];
    for(let p = size - 7; pos.length < n; p -= step) pos.splice(1, 0, p);
    pos.forEach((ax, i) => pos.forEach((ay, j) => {
      if((i === 0 && j === 0) || (i === 0 && j === n - 1) || (i === n - 1 && j === 0)) return;
      for(let dy = -2; dy <= 2; dy++) for(let dx = -2; dx <= 2; dx++)
        set(ax + dx, ay + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }));
  }
  const drawFormat = mask => {
    const d = (0 << 3) | mask;                // 레벨 M의 형식 비트는 00
    let r = d;
    for(let i = 0; i < 10; i++) r = (r << 1) ^ ((r >>> 9) * 0x537);
    const b = ((d << 10) | r) ^ 0x5412;
    const bit = i => ((b >>> i) & 1) === 1;
    for(let i = 0; i <= 5; i++) set(8, i, bit(i));
    set(8, 7, bit(6)); set(8, 8, bit(7)); set(7, 8, bit(8));
    for(let i = 9; i < 15; i++) set(14 - i, 8, bit(i));
    for(let i = 0; i < 8; i++) set(size - 1 - i, 8, bit(i));
    for(let i = 8; i < 15; i++) set(8, size - 15 + i, bit(i));
    set(8, size - 8, true);
  };
  drawFormat(0);                              // 자리만 잡는다(기능 칸 표시). 마스크를 고른 뒤 다시 그린다
  if(ver >= 7){
    let r = ver;
    for(let i = 0; i < 12; i++) r = (r << 1) ^ ((r >>> 11) * 0x1F25);
    const b = (ver << 12) | r;
    for(let i = 0; i < 18; i++){
      const d = ((b >>> i) & 1) === 1, a = size - 11 + i % 3, c = Math.floor(i / 3);
      set(a, c, d); set(c, a, d);
    }
  }

  // ── 데이터 배치(오른쪽 아래부터 두 칸씩 지그재그) ──
  let bi = 0;
  for(let right = size - 1; right >= 1; right -= 2){
    if(right === 6) right = 5;
    for(let v = 0; v < size; v++) for(let j = 0; j < 2; j++){
      const x = right - j, up = ((right + 1) & 2) === 0, y = up ? size - 1 - v : v;
      if(!fn[y][x] && bi < cw.length * 8){ mod[y][x] = ((cw[bi >>> 3] >>> (7 - (bi & 7))) & 1) === 1; bi++; }
    }
  }

  // ── 마스크: 8개를 다 대 보고 벌점이 가장 낮은 것 ──
  const applyMask = m => {
    for(let y = 0; y < size; y++) for(let x = 0; x < size; x++)
      if(!fn[y][x] && MASKS[m](x, y)) mod[y][x] = !mod[y][x];
  };
  let best = 0, bestScore = Infinity;
  for(let m = 0; m < 8; m++){
    applyMask(m); drawFormat(m);
    const s = penalty(mod, size);
    if(s < bestScore){ bestScore = s; best = m; }
    applyMask(m);                              // XOR이라 한 번 더 하면 원래대로
  }
  applyMask(best); drawFormat(best);
  return {size, version:ver, dark:(x, y) => mod[y][x]};
}

// 벌점(규격의 4규칙). 판독 가능 여부와는 무관하고, 잘 읽히는 마스크를 고르는 데만 쓴다.
function penalty(mod, size){
  let s = 0;
  const lines = [];
  for(let i = 0; i < size; i++){
    lines.push(mod[i].map(Number).join(''));
    lines.push(mod.map(r => Number(r[i])).join(''));
  }
  for(const ln of lines){
    for(const run of ln.match(/0+|1+/g)) if(run.length >= 5) s += run.length - 2;          // 규칙 1: 같은 색 5칸 이상
    const padded = '0000' + ln + '0000';
    s += 40 * ((padded.match(/(?=00001011101)/g) || []).length + (padded.match(/(?=10111010000)/g) || []).length); // 규칙 3
  }
  let dark = 0;
  for(let y = 0; y < size; y++) for(let x = 0; x < size; x++){
    if(mod[y][x]) dark++;
    if(x < size - 1 && y < size - 1){
      const c = mod[y][x];
      if(c === mod[y][x + 1] && c === mod[y + 1][x] && c === mod[y + 1][x + 1]) s += 3;    // 규칙 2: 2×2 같은 색
    }
  }
  s += Math.floor(Math.abs(dark * 20 - size * size * 10) / (size * size)) * 10;          // 규칙 4: 흑백 균형
  return s;
}

// SVG 문자열. 조용한 여백(quiet zone) 4칸 포함 — 규격 최소값. 줄이면 스캐너가 테두리를 못 찾는다.
export function qrSvg(text){
  const q = qrMatrix(text), n = q.size + 8;
  let d = '';
  for(let y = 0; y < q.size; y++) for(let x = 0; x < q.size; x++)
    if(q.dark(x, y)) d += `M${x + 4} ${y + 4}h1v1h-1z`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n} ${n}" shape-rendering="crispEdges">` +
         `<rect width="${n}" height="${n}" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
}
