/* PDFノート — Service Worker（オフライン動作＋更新管理）
 *
 *  ・初回アクセス時にアプリ一式をキャッシュ → 以降はオフラインでも起動できる
 *  ・新しい版を公開して VERSION を上げると、ブラウザが新SWを検出して「待機」する
 *  ・アプリの「更新」ボタンが skipWaiting を送ると新版が有効化され、画面を再読み込みする
 *
 *  ★ 新しい版を GitHub に上げるときは、必ず下の VERSION を書き換えてください（例: 日付）。
 *    VERSION が変わらないと、ブラウザは「更新なし」と判断します。
 */
const VERSION = '20260825f';                 // ← 公開のたびに変更する
const CACHE = 'pdfnote-' + VERSION;

// キャッシュするファイル（SW自身の場所からの相対パス）
const ASSETS = [
  './',
  './index.html',
  './style.css',
  './manifest.webmanifest',
  './icon.svg',
  './js/storage.js',
  './js/ui.js',
  './js/library.js',
  './js/editor.js',
  './js/pages.js',
  './js/app.js',
  './vendor/pdfjs/pdf.min.js',
  './vendor/pdfjs/pdf.worker.min.js',
  './vendor/jspdf/jspdf.umd.min.js'
];

self.addEventListener('install', (e) => {
  // 新版はすぐには有効化せず「待機」させる（更新ボタンで反映）
  e.waitUntil((async () => {
    const c = await caches.open(CACHE);
    // ★ 必ずサーバから取り直す（cache:'reload' でブラウザのHTTPキャッシュを迂回）。
    //   これをしないと、GitHub Pages のキャッシュが残っているあいだは
    //   「バージョン番号だけ新しく、中身は古いまま」になってしまう。
    for (const url of ASSETS) {
      try {
        const res = await fetch(new Request(url, { cache: 'reload' }));
        if (res && res.ok) await c.put(url, res);
      } catch (err) { /* 1つ失敗しても、残りのファイルは取得を続ける */ }
    }
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// アプリから「更新して」の合図を受けたら、待機中の新版を有効化する
self.addEventListener('message', (e) => {
  if (e.data === 'skipWaiting') self.skipWaiting();
  if (e.data === 'version') {
    if (e.source && e.source.postMessage) e.source.postMessage({ type: 'version', version: VERSION });
  }
});

// キャッシュ優先（オフライン対応）。無ければ取得してキャッシュに追加
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;      // 外部は素通し
  e.respondWith(
    caches.match(req).then((hit) => {
      if (hit) return hit;
      return fetch(req).then((res) => {
        if (res && res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
        return res;
      }).catch(() => caches.match('./index.html'));   // オフラインでの画面遷移の保険
    })
  );
});
