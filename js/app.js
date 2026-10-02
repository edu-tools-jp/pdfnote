/* PDFノート — 起動と画面切り替え */
window.PN = window.PN || {};

PN.app = (function () {
  const $ = (s) => document.querySelector(s);
  let restoreHandle = null;

  // ★ 公開のたびに、この値と service-worker.js の VERSION を「同じ値」に変えること。
  //    食い違うと「表示中のファイルが古いようです」の案内が出る（それが食い違い検知のしくみ）。
  //    値は「その日の日付＋枝番」＝ 20260916a（同じ日に2回目なら 20260916b）。
  //    ★前回の日付を使い回さないこと。この日付をそのまま「いつの更新か」として見せている。
  const APP_VERSION = '20261002a';

  /* 更新内容は release-notes.json に置く（サーバ上の最新をそのつど読む）。
     公開のたびに、いちばん上へ今回の版の項目を足すこと。 */
  const NOTES_URL = 'release-notes.json';
  let swReg = null, waitingWorker = null, swReloading = false;

  function showOnly(id) {
    ['#screen-start', '#screen-library', '#screen-editor'].forEach(s => { $(s).hidden = (s !== id); });
    const pg = $('#screen-pages'); if (pg) pg.hidden = true;   // ページ一覧オーバーレイは常に閉じる
    if (PN.tabs) PN.tabs.render();                              // 最初の画面ではタブを出さない
  }

  async function boot() {
    // PDF.js ワーカー（ローカル同梱。file:// で失敗してもメインスレッドで動く）
    if (window.pdfjsLib) {
      try { pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdfjs/pdf.worker.min.js'; } catch (e) {}
    }

    PN.library.init();
    PN.editor.init();
    PN.pages.init();
    PN.tabs.init();
    bindStart();
    bindFileInput();
    showBuildStamp();
    initServiceWorker();
    const upd = $('#btn-update'); if (upd) upd.addEventListener('click', checkForUpdate);
    window.addEventListener('beforeunload', () => { PN.editor.flushSave(); });

    if (!window.showDirectoryPicker) {
      $('#unsupported').hidden = false;
      $('#start-actions').style.display = 'none';
      $('#start-hint').hidden = true;
      showOnly('#screen-start');
      return;
    }

    showOnly('#screen-start');
    try {
      const r = await PN.storage.tryRestore();
      if (r.state === 'ready') { showLibrary(); return; }
      if (r.state === 'prompt') {
        restoreHandle = r.handle;
        const b = $('#btn-use-previous');
        b.hidden = false; b.textContent = `前回のフォルダ「${r.name}」を使う`;
        $('#btn-pick-folder').hidden = true;
        $('#btn-pick-other').hidden = false;
      }
    } catch (e) { console.error(e); }
  }

  function bindStart() {
    $('#btn-pick-folder').addEventListener('click', doPick);
    $('#btn-pick-other').addEventListener('click', doPick);
    $('#btn-use-previous').addEventListener('click', async () => {
      try {
        if (await PN.storage.usePrevious(restoreHandle)) showLibrary();
        else PN.ui.toast('フォルダの使用が許可されませんでした。選び直してください');
      } catch (e) {
        if (e && e.name === 'AbortError') return;
        console.error(e);
        alert('前回のフォルダを使えませんでした。\n\n' + describeErr(e));
      }
    });
  }
  async function doPick() {
    if (!window.showDirectoryPicker) {
      alert('このブラウザはフォルダ保存（File System Access API）に対応していません。\nGoogle Chrome か Microsoft Edge でひらき直してください。');
      return;
    }
    try {
      if (await PN.storage.pickFolder()) showLibrary();
    } catch (e) {
      if (e && e.name === 'AbortError') return;   // ユーザーがキャンセルしただけ
      console.error(e);
      alert('フォルダを開けませんでした。\n\n' + describeErr(e) +
        '\n\n（このメッセージをそのまま伝えていただけると原因を特定できます）');
    }
  }
  function describeErr(e) {
    if (!e) return '不明なエラー';
    if (e.name || e.message) return (e.name || 'Error') + ': ' + (e.message || '');
    return String(e);
  }

  /* 今より新しい版の更新内容だけを取り出す。
     いちばん上から見ていき、いま動いている版に当たったらそこで止める。 */
  async function fetchNewNotes() {
    try {
      const res = await fetch(NOTES_URL + '?t=' + Date.now(), { cache: 'no-store' });
      if (!res.ok) return null;
      const all = await res.json();
      if (!Array.isArray(all)) return null;
      const fresh = [];
      for (const n of all) { if (n && n.version === APP_VERSION) break; if (n) fresh.push(n); }
      return fresh;
    } catch (e) { return null; }
  }

  /* 更新するか、内容を見せたうえで聞く */
  async function askAndUpdate(worker) {
    PN.ui.busy(true, '更新内容を確認中…');
    const notes = await fetchNewNotes();
    PN.ui.busy(false);
    const ok = await PN.ui.info({
      title: '新しいバージョンがあります',
      lead: (notes && notes.length)
        ? '更新すると、次のように変わります。画面が再読み込みされますが、書き込みは保存済みです。'
        : '更新内容を読み込めませんでした（ネット接続を確認してください）。更新すると画面が再読み込みされますが、書き込みは保存済みです。',
      // 先生には版番号より「いつの更新か」が要るので、日付にして見せる
      notes: (notes || []).map(n => Object.assign({}, n,
        { version: verDate(n.version) ? verDate(n.version) + 'の更新' : n.version })),
      ok: '更新する', cancel: 'あとで'
    });
    if (ok) worker.postMessage('skipWaiting');   // → controllerchange で自動リロード
  }

  /* 版番号は「更新日＋枝番」。20260916a → 2026年9月16日 */
  function verDate(v) {
    const m = /^(\d{4})(\d{2})(\d{2})/.exec(String(v || ''));
    return m ? (+m[1] + '年' + (+m[2]) + '月' + (+m[3]) + '日') : '';
  }

  /* 画面すみの版番号は APP_VERSION から入れる（手書きの重複を作らない） */
  function showBuildStamp() {
    const d = verDate(APP_VERSION);
    document.querySelectorAll('.build-stamp').forEach(el => {
      el.textContent = APP_VERSION;
      el.title = 'アプリのバージョン ' + APP_VERSION + (d ? '（' + d + 'の更新）' : '');
    });
  }

  /* ---- Service Worker（オフライン動作＋更新ボタン） ---- */
  async function initServiceWorker() {
    const upd = $('#btn-update');
    // http/https のときだけ（GitHub Pages 等）。file:// では使えない
    if (!('serviceWorker' in navigator) || !/^https?:$/.test(location.protocol)) {
      if (upd) upd.hidden = true;
      return;
    }
    if (upd) { upd.hidden = false; upd.title = '最新版に更新する（現在 ' + APP_VERSION + '）'; }
    try {
      swReg = await navigator.serviceWorker.register('service-worker.js');
      // ブラウザの設定や学校のポリシーで Service Worker が使えないことがある
      if (!swReg) { if (upd) upd.title = 'オフライン機能を有効にできませんでした'; return; }
      if (swReg.waiting && navigator.serviceWorker.controller) markUpdateReady(swReg.waiting);
      swReg.addEventListener('updatefound', () => {
        const nw = swReg.installing;
        if (!nw) return;
        nw.addEventListener('statechange', () => {
          if (nw.state === 'installed' && navigator.serviceWorker.controller) markUpdateReady(nw);
        });
      });
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (swReloading) return; swReloading = true; location.reload();
      });
      // 表示中のファイルと Service Worker のバージョンが食い違っていたら知らせる
      // （キャッシュの取り違えで「番号だけ新しい」状態になっていないかの確認）
      navigator.serviceWorker.addEventListener('message', (ev) => {
        const d = ev.data;
        if (d && d.type === 'version' && d.version && d.version !== APP_VERSION) {
          PN.ui.toast('表示中のファイルが古いようです。Ctrl+Shift+R で読み込み直してください', 7000);
        }
      });
      setTimeout(() => {
        try { if (navigator.serviceWorker.controller) navigator.serviceWorker.controller.postMessage('version'); } catch (e) {}
      }, 2500);
      // たまに自動で更新チェック（起動時・以後1時間ごと）
      setTimeout(() => { try { swReg.update(); } catch (e) {} }, 4000);
      setInterval(() => { try { swReg && swReg.update(); } catch (e) {} }, 60 * 60 * 1000);
    } catch (e) {
      console.error('Service Worker 登録失敗', e);
      if (upd) upd.title = 'オフライン機能を有効にできませんでした';
    }
  }
  function markUpdateReady(worker) {
    waitingWorker = worker;
    const upd = $('#btn-update');
    if (upd) {
      upd.hidden = false; upd.classList.add('has-update');
      const lbl = upd.querySelector('.lbl'); if (lbl) lbl.textContent = '更新（新版あり）';
      upd.title = '新しい版があります。押すと最新版になります';
    }
  }
  /* 新しい版が見つかって、入り終わるまで待つ。
     見つからなければ FIND_MS ほどで「無し」と判断し、待たせすぎない。
     見つかったら、入り終わるまで最大 INSTALL_MS 待つ。
     ※ 以前は update() のあと決め打ちの時間だけ待っていたため、通信が遅いと
       入り終わる前に「最新の状態です」と出て、そのあとで更新ボタンだけが
       緑色になる、という食い違いが起きていた。 */
  const FIND_MS = 2000, INSTALL_MS = 30000;
  function waitForNewWorker(reg) {
    return new Promise((resolve) => {
      let settled = false, tFind = null, tInstall = null;
      const finish = (w) => {
        if (settled) return;
        settled = true;
        clearTimeout(tFind); clearTimeout(tInstall);
        reg.removeEventListener('updatefound', onFound);
        resolve(w || null);
      };
      const watch = (nw) => {
        if (!nw) return;
        clearTimeout(tFind);                       // 見つかったので「無し」の判断はやめる
        tInstall = setTimeout(() => finish(reg.waiting || null), INSTALL_MS);
        if (nw.state === 'installed') { finish(reg.waiting || nw); return; }
        nw.addEventListener('statechange', () => {
          if (nw.state === 'installed') finish(reg.waiting || nw);
          else if (nw.state === 'redundant') finish(null);   // 入れ替えに失敗した
        });
      };
      const onFound = () => watch(reg.installing);
      if (reg.waiting) { finish(reg.waiting); return; }
      reg.addEventListener('updatefound', onFound);
      tFind = setTimeout(() => finish(reg.waiting || waitingWorker), FIND_MS);
      watch(reg.installing);                       // もう始まっていることもある
    });
  }

  async function checkForUpdate() {
    if (!swReg) { PN.ui.toast('この開き方では更新機能は使えません（GitHub Pages のURLで開いてください）'); return; }
    // すでに新版が待機していれば、それを適用
    const ready = waitingWorker || swReg.waiting;
    if (ready) { await askAndUpdate(ready); return; }
    // サーバに最新があるか確認
    PN.ui.busy(true, '更新を確認中…');
    try {
      const watching = waitForNewWorker(swReg);   // update() より先に見張りを始める
      try { await swReg.update(); } catch (e) { /* 見張りの結果で判断する */ }
      const w = await watching;
      PN.ui.busy(false);
      if (w) {
        await askAndUpdate(w);
      } else {
        PN.ui.toast('最新の状態です（' + APP_VERSION + '）');
      }
    } catch (e) {
      PN.ui.busy(false); console.error(e);
      PN.ui.toast('更新の確認に失敗しました。ネット接続を確認してください');
    }
  }

  let pendingAddPosition = 'end';
  function bindFileInput() {
    $('#file-input').addEventListener('change', async (e) => {
      const files = [...e.target.files];
      e.target.value = '';
      if (files.length) await PN.editor.addFiles(files, pendingAddPosition);
    });
    // ページの上に置く画像（写真を選ぶ）
    $('#image-input').addEventListener('change', async (e) => {
      const f = e.target.files && e.target.files[0];
      e.target.value = '';
      if (f) await PN.editor.placeImage(f);
    });
  }
  function pickImageForPage() { $('#image-input').click(); }

  /* ---- 画面遷移 ---- */
  function showLibrary() { showOnly('#screen-library'); PN.library.show(); }
  function showEditorScreen() { showOnly('#screen-editor'); }

  /* 開く・戻るは、タブ（js/tabs.js）を通す。
     一覧に戻ってもタブは残り、押せばまたそのノートの続きから見られる */
  async function openEditor(nb, pickAfter) { await PN.tabs.openNotebook(nb, pickAfter); }
  async function backToLibrary() { await PN.tabs.goHome(); }

  const PICK_ACCEPT = {
    image: 'image/png,image/jpeg,image/webp',
    pdf: 'application/pdf',
    any: 'application/pdf,image/png,image/jpeg,image/webp'
  };
  /* ページに入れるファイルを選ぶ。
     position: 'before' | 'after' | 'end'、kind: 'image' | 'pdf'（省略で両方） */
  function pickFilesForCurrentNotebook(position, kind) {
    pendingAddPosition = position || 'end';
    const inp = $('#file-input');
    inp.accept = PICK_ACCEPT[kind] || PICK_ACCEPT.any;
    inp.click();
  }

  return { boot, showLibrary, showEditorScreen, openEditor, backToLibrary, pickFilesForCurrentNotebook, pickImageForPage };
})();

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', PN.app.boot);
else PN.app.boot();
