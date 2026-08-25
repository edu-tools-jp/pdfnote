/* PDFノート — 起動と画面切り替え */
window.PN = window.PN || {};

PN.app = (function () {
  const $ = (s) => document.querySelector(s);
  let restoreHandle = null;

  // ★ 公開のたびに、この値と service-worker.js の VERSION を「同じ値」に変えること。
  //    食い違うと「表示中のファイルが古いようです」の案内が出る（それが食い違い検知のしくみ）。
  const APP_VERSION = '20260825l';

  /* 更新のたびに、いちばん上へ新しい項目を足す（先生に知らせる内容）。
     ここに書いた内容が、更新後にアプリを開いたとき自動で表示される。 */
  const RELEASE_NOTES = [
    {
      version: '20260825l',
      title: 'フォルダの色分けと、更新のお知らせ',
      items: [
        'フォルダごとに色を選べるようになりました（フォルダの ⋯ →「色を変える」、または新規作成時）。',
        'アプリが新しくなったとき、変わった点をこの画面でお知らせするようにしました。'
      ]
    },
    {
      version: '20260825k',
      title: '画面の見た目を整えました',
      items: [
        '道具のアイコンを描き直し、アプリ全体で見た目を統一しました。',
        '上のツールバーが、どの道具を選んでも2行に収まるようにしました。'
      ]
    }
  ];
  const LAST_SEEN_KEY = 'pdfnote.lastSeenVersion';
  let swReg = null, waitingWorker = null, swReloading = false;

  function showOnly(id) {
    ['#screen-start', '#screen-library', '#screen-editor'].forEach(s => { $(s).hidden = (s !== id); });
    const pg = $('#screen-pages'); if (pg) pg.hidden = true;   // ページ一覧オーバーレイは常に閉じる
  }

  async function boot() {
    // PDF.js ワーカー（ローカル同梱。file:// で失敗してもメインスレッドで動く）
    if (window.pdfjsLib) {
      try { pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdfjs/pdf.worker.min.js'; } catch (e) {}
    }

    PN.library.init();
    PN.editor.init();
    PN.pages.init();
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

  /* 前に開いたときより新しくなっていたら、変わった点をお知らせする。
     初めて開いたときや、同じ版のときは何も出さない。 */
  let whatsNewShown = false;
  function showWhatsNew() {
    if (whatsNewShown) return;
    whatsNewShown = true;
    let last = null;
    try { last = localStorage.getItem(LAST_SEEN_KEY); } catch (e) { return; }
    try { localStorage.setItem(LAST_SEEN_KEY, APP_VERSION); } catch (e) {}
    if (!last || last === APP_VERSION) return;
    const fresh = [];
    for (const n of RELEASE_NOTES) { if (n.version === last) break; fresh.push(n); }
    if (!fresh.length) return;
    PN.ui.info({ title: 'PDFノートが新しくなりました', notes: fresh });
  }

  /* 画面すみの版番号は APP_VERSION から入れる（手書きの重複を作らない） */
  function showBuildStamp() {
    document.querySelectorAll('.build-stamp').forEach(el => {
      el.textContent = APP_VERSION;
      el.title = 'アプリのバージョン ' + APP_VERSION;
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
  async function checkForUpdate() {
    if (!swReg) { PN.ui.toast('この開き方では更新機能は使えません（GitHub Pages のURLで開いてください）'); return; }
    // すでに新版が待機していれば、それを適用
    const ready = waitingWorker || swReg.waiting;
    if (ready) {
      if (await PN.ui.confirm('新しいバージョンがあります。今すぐ更新しますか？\n（画面が再読み込みされます。書き込みは保存済みです）', { ok: '更新する' })) {
        ready.postMessage('skipWaiting');   // → controllerchange で自動リロード
      }
      return;
    }
    // サーバに最新があるか確認
    PN.ui.busy(true, '更新を確認中…');
    try {
      await swReg.update();
      await new Promise((r) => setTimeout(r, 1200));
      const w = swReg.waiting || waitingWorker;
      PN.ui.busy(false);
      if (w) {
        if (await PN.ui.confirm('新しいバージョンが見つかりました。今すぐ更新しますか？\n（画面が再読み込みされます）', { ok: '更新する' })) w.postMessage('skipWaiting');
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
  function showLibrary() { showOnly('#screen-library'); PN.library.show(); showWhatsNew(); }

  async function openEditor(nb, pickAfter) {
    showOnly('#screen-editor');
    await PN.editor.open(nb);
    if (pickAfter) pickFilesForCurrentNotebook();
  }

  async function backToLibrary() {
    await PN.editor.close();
    showLibrary();
  }

  async function pickFilesForCurrentNotebook(forcePosition) {
    // 既にページがある場合は、追加位置（今の直後 / 最後）を選ばせる
    const pages = PN.editor.getPages ? PN.editor.getPages() : [];
    if (forcePosition) {
      pendingAddPosition = forcePosition;
    } else if (pages.length > 0) {
      const pos = await PN.ui.choose({
        title: 'どこにページを追加しますか？',
        options: [
          { value: 'after', label: '今のページの直後に追加' },
          { value: 'end', label: '最後に追加' }
        ]
      });
      if (!pos) return;   // キャンセル
      pendingAddPosition = pos;
    } else {
      pendingAddPosition = 'end';
    }
    $('#file-input').click();
  }

  return { boot, showLibrary, openEditor, backToLibrary, pickFilesForCurrentNotebook, pickImageForPage };
})();

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', PN.app.boot);
else PN.app.boot();
