/* PDFノート — 起動と画面切り替え */
window.PN = window.PN || {};

PN.app = (function () {
  const $ = (s) => document.querySelector(s);
  let restoreHandle = null;

  const APP_VERSION = '2026-06-01-05';   // 表示用（service-worker.js の VERSION と揃える）
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
      alert('このブラウザはフォルダ保存（File System Access API）に対応していません。\nGoogle Chrome か Microsoft Edge で、付属の「PDF-Note-Start.bat」から開いてください。');
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
    if (upd) { upd.hidden = false; upd.classList.add('has-update'); upd.textContent = '🔄 更新（新版あり）'; }
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
  }

  /* ---- 画面遷移 ---- */
  function showLibrary() { showOnly('#screen-library'); PN.library.show(); }

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

  return { boot, showLibrary, openEditor, backToLibrary, pickFilesForCurrentNotebook };
})();

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', PN.app.boot);
else PN.app.boot();
