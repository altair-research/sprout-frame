// 서비스 워커 — 오프라인 실행용.
// 사진은 여기서 다루지 않는다(IndexedDB에 있음). 캐시하는 건 앱 껍데기 5개 파일뿐.
//
// ⚠️ 버전은 version.js 한 곳에서 올린다(화면에도 같은 값이 보인다).
importScripts('./version.js');
const VERSION = self.GC_VERSION;
const CACHE = 'sproutframe-' + VERSION;   // 옛 'ghostcam-*' 캐시는 activate에서 함께 지워진다

const SHELL = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './qr.js',
  './version.js',
  './manifest.webmanifest',
  './privacy.html',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/favicon-32.png',
];

self.addEventListener('install', e => {
  // ⚠️ `cache: 'reload'`가 핵심. 그냥 addAll(SHELL)을 쓰면 fetch가 기본 캐시 모드로 돌아가
  //    **브라우저 HTTP 캐시에 있던 옛 파일을 그대로 새 캐시에 집어넣는다.**
  //    2026-08-21에 실제로 당함: VERSION을 올렸는데 v2 캐시 안에 옛 style.css가 들어앉아
  //    JS만 갱신되고 화면 비율은 그대로였다. 서버 헤더(no-cache)에 기대면 안 되는 이유 —
  //    아이콘처럼 max-age가 긴 파일은 그 기간 내내 옛 것이 캐시된다.
  const fresh = SHELL.map(u => new Request(u, {cache: 'reload'}));
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(fresh)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      // **내 이름으로 시작하는 캐시만** 지운다. altair-research.github.io 는 drape 등 다른 앱과 같은 사이트(오리진)라
      // 캐시 저장소를 같이 쓴다. 예전처럼 "내 것이 아니면 전부 삭제"하면 남의 앱 오프라인 캐시를 지운다(2026-09-24 발견).
      .then(keys => Promise.all(keys.filter(k => (k.startsWith('sproutframe-') || k.startsWith('ghostcam-')) && k !== CACHE)
                                    .map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  if (new URL(req.url).origin !== self.location.origin) return;

  // 페이지 요청도 캐시 우선 — HTML과 JS가 **항상 같은 버전**에서 나오게 한다.
  // 전에는 페이지만 네트워크 우선이라, 배포 직후 첫 실행에서 새 HTML + 캐시의 옛 JS가 섞였다.
  // 새 HTML에서 지운 요소를 옛 JS가 찾다가 멈췄다(2026-09-24, v33 검증 중 실측: ghostFile).
  // 새 버전은 서비스 워커가 뒤에서 받아 두었다가 **다음 실행**에 통째로 바뀐다 — 원래도 "두 번 열기"였다.
  //
  // ⚠️ 캐시의 './index.html'을 그대로 내주면 안 된다. Cloudflare는 /index.html 을 / 로 **리다이렉트(307)**하고,
  //    그 '리다이렉트를 거친 응답'이 캐시에 들어간다. 크롬은 그런 응답으로 페이지를 여는 것을 거부한다 → ERR_FAILED.
  //    v33~v34의 옛 주소(홈 화면 앱)가 실제로 이렇게 안 열렸다(2026-09-24). GitHub Pages·로컬 서버는 리다이렉트가 없어 못 잡았다.
  //    그래서 './'(리다이렉트 없음)를 먼저 찾고, 그래도 리다이렉트 흔적이 있으면 본문만 옮겨 새 응답을 만든다.
  if (req.mode === 'navigate') {
    e.respondWith((async () => {
      const hit = (await caches.match('./')) || (await caches.match('./index.html'));
      if (!hit) return fetch(req);
      if (!hit.redirected) return hit;
      return new Response(await hit.blob(), {status: 200, statusText: 'OK', headers: hit.headers});
    })());
    return;
  }

  // 나머지(css/js/아이콘)는 캐시 우선 — 빠르고, 오프라인에서도 뜬다.
  e.respondWith(
    caches.match(req).then(hit => hit || fetch(req).then(res => {
      if (res.ok) {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(req, copy));
      }
      return res;
    }))
  );
});
