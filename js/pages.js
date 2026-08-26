/* PDFノート — ページ一覧（サムネイル表示・選択・並べ替え・削除/コピー/PDF書き出し） */
window.PN = window.PN || {};

PN.pages = (function () {
  const $ = (s) => document.querySelector(s);

  let root, gridEl, countEl;
  let order = [];                 // 表示順のページID配列
  const selected = new Set();     // 選択中のページID
  const thumbCache = {};          // id -> dataURL
  let drag = null;                // ドラッグ状態
  let placeholder = null;         // 挿入位置を示す枠
  const LONG_PRESS_MS = 500;      // この時間押し続けると「移動モード」になる
  const MOVE_CANCEL = 10;         // 長押し成立前にこれ以上動いたら、スクロール操作とみなす

  function init() {
    root = $('#screen-pages');
    gridEl = $('#pages-grid');
    countEl = $('#pages-count');
    $('#pages-close').addEventListener('click', close);
    $('#pages-selectall').addEventListener('click', toggleSelectAll);
    $('#pages-add').addEventListener('click', () => { close(); PN.editor.addPageDialog(); });
    $('#pages-delete').addEventListener('click', doDelete);
    $('#pages-copy').addEventListener('click', doCopy);
    $('#pages-export').addEventListener('click', doExport);
    // ドラッグ（並べ替え）
    document.addEventListener('pointermove', onDragMove);
    document.addEventListener('pointerup', onDragEnd);
    document.addEventListener('pointercancel', onDragCancel);
  }

  function open() {
    const pages = PN.editor.getPages();
    if (!pages.length) { PN.ui.toast('ページがありません'); return; }
    order = pages.map(p => p.id);
    selected.clear();
    root.hidden = false;
    render();
    // サムネを順次生成
    pages.forEach(p => ensureThumb(p));
  }
  function close() {
    if (drag) { clearTimeout(drag.timer); document.removeEventListener('touchmove', blockScroll, { passive: false }); drag = null; }
    placeholder = null;
    root.hidden = true; gridEl.innerHTML = '';
  }

  function render() {
    gridEl.innerHTML = '';
    const pages = PN.editor.getPages();
    const byId = new Map(pages.map(p => [p.id, p]));
    order.forEach((id, i) => {
      const p = byId.get(id); if (!p) return;
      const card = document.createElement('div');
      card.className = 'pg-card' + (selected.has(id) ? ' selected' : '');
      card.dataset.id = id;
      card.innerHTML = `
        <div class="pg-check">${selected.has(id) ? PN.ui.icon('check') : ''}</div>
        <div class="pg-thumb" title="タップで選択 / ダブルクリックで開く / ドラッグで並べ替え">${thumbCache[id] ? `<img src="${thumbCache[id]}" alt="" draggable="false">` : '<span>…</span>'}</div>
        <div class="pg-num">${i + 1}</div>`;
      // チェックは常に選択トグル
      card.querySelector('.pg-check').addEventListener('click', (e) => { e.stopPropagation(); toggleSelect(id); });
      // サムネ本体：軽くタップ＝選択、ダブルクリック＝そのページを開く、ドラッグ＝並べ替え
      const thumb = card.querySelector('.pg-thumb');
      thumb.addEventListener('pointerdown', (e) => onPointerDown(e, id, card, true));
      thumb.addEventListener('dblclick', () => { close(); PN.editor.gotoPageId(id); });
      gridEl.appendChild(card);
    });
    updateCount();
  }

  function updateCount() {
    const n = selected.size, total = order.length;
    countEl.textContent = n ? `${n} ページ選択中 / 全${total}ページ` : `全${total}ページ（タップで選択）`;
    const has = n > 0;
    $('#pages-delete').disabled = !has;
    $('#pages-copy').disabled = !has;
    $('#pages-export').disabled = !has;
    $('#pages-selectall').textContent = (n === total && total > 0) ? '全解除' : '全選択';
  }

  function toggleSelect(id) {
    if (selected.has(id)) selected.delete(id); else selected.add(id);
    const card = gridEl.querySelector(`.pg-card[data-id="${cssEsc(id)}"]`);
    if (card) {
      card.classList.toggle('selected', selected.has(id));
      card.querySelector('.pg-check').innerHTML = selected.has(id) ? PN.ui.icon('check') : '';
    }
    updateCount();
  }
  function toggleSelectAll() {
    if (selected.size === order.length) selected.clear();
    else order.forEach(id => selected.add(id));
    render();
  }

  /* 選択順ではなく表示順（order）で選択IDを返す */
  function selectedInOrder() { return order.filter(id => selected.has(id)); }

  async function doDelete() {
    const ids = selectedInOrder(); if (!ids.length) return;
    if (ids.length >= order.length) { PN.ui.toast('すべてのページは削除できません。1ページは残してください'); return; }
    if (!(await PN.ui.confirm(`選択した ${ids.length} ページを削除します。書き込みも消えます。元に戻せません。よろしいですか？`, { danger: true, ok: '削除する' }))) return;
    await PN.editor.deletePagesByIds(ids);
    ids.forEach(id => { selected.delete(id); delete thumbCache[id]; });
    refreshOrder();
  }
  async function doCopy() {
    const ids = selectedInOrder(); if (!ids.length) return;
    await PN.editor.duplicatePagesByIds(ids);
    selected.clear();
    refreshOrder();
    PN.ui.toast(ids.length + ' ページをコピーしました');
    PN.editor.getPages().forEach(p => ensureThumb(p));
  }
  async function doExport() {
    const ids = selectedInOrder(); if (!ids.length) return;
    await PN.editor.exportPagesToPdf(ids);
  }

  /* ページ操作後、order を最新の並びに合わせ直して再描画 */
  function refreshOrder() {
    const pages = PN.editor.getPages();
    if (!pages.length) { close(); return; }
    order = pages.map(p => p.id);
    render();
    pages.forEach(p => ensureThumb(p));
  }

  /* ---- サムネ生成 ---- */
  async function ensureThumb(p) {
    if (thumbCache[p.id]) return;
    try {
      const canvas = await PN.editor.composePage(p, 240, { ink: true, masks: true });
      thumbCache[p.id] = canvas.toDataURL('image/png');
      const card = gridEl.querySelector(`.pg-card[data-id="${cssEsc(p.id)}"] .pg-thumb`);
      if (card) card.innerHTML = `<img src="${thumbCache[p.id]}" alt="">`;
    } catch (e) { /* 生成失敗は…のまま */ }
  }

  /* ---- ドラッグ並べ替え（サムネイルをドラッグ、ページの間に落とすとそこへ挿入） ---- */
  function onPointerDown(e, id, card, selectable) {
    if (e.button != null && e.button !== 0) return;   // 左ボタンのみ
    // ここでは preventDefault しない（指でのスクロールを妨げないため）
    const r = card.getBoundingClientRect();
    drag = {
      id, card, selectable, pointerId: e.pointerId,
      startX: e.clientX, startY: e.clientY,
      offsetX: e.clientX - r.left, offsetY: e.clientY - r.top,
      w: r.width, h: r.height, active: false, order0: order.join()
    };
    // 押し続けたら「移動モード」に入る。途中で動かしたらスクロール扱いで取り消す
    drag.timer = setTimeout(activateDrag, LONG_PRESS_MS);
  }
  /* 長押し成立：カードを持ち上げて移動できる状態にする */
  function activateDrag() {
    if (!drag) return;
    // 一覧が作り直された等で、掴んだカードが今の一覧に無ければ何もしない
    if (drag.card.parentNode !== gridEl) { drag = null; return; }
    drag.active = true;
    // 元の位置に「挿入枠（プレースホルダ）」を置き、カードは浮かせて指/マウスに追従
    placeholder = document.createElement('div');
    placeholder.className = 'pg-card pg-placeholder';
    placeholder.style.width = drag.w + 'px'; placeholder.style.height = drag.h + 'px';
    gridEl.insertBefore(placeholder, drag.card);
    drag.card.classList.add('dragging');
    drag.card.style.position = 'fixed';
    drag.card.style.zIndex = '60';
    drag.card.style.width = drag.w + 'px';
    drag.card.style.pointerEvents = 'none';
    drag.card.style.left = (drag.startX - drag.offsetX) + 'px';
    drag.card.style.top = (drag.startY - drag.offsetY) + 'px';
    // 移動中は画面スクロールを止める（長押し中はまだスクロールが始まっていないので有効）
    document.addEventListener('touchmove', blockScroll, { passive: false });
    try { drag.card.setPointerCapture(drag.pointerId); } catch (err) {}
    if (navigator.vibrate) { try { navigator.vibrate(30); } catch (err) {} }
  }
  function blockScroll(e) { if (drag && drag.active) e.preventDefault(); }

  function onDragMove(e) {
    if (!drag) return;
    if (!drag.active) {
      // 長押しが成立する前に動いた ＝ スクロールしたいだけ。並べ替えは開始しない
      if (Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) > MOVE_CANCEL) {
        clearTimeout(drag.timer); drag = null;
      }
      return;
    }
    drag.card.style.left = (e.clientX - drag.offsetX) + 'px';
    drag.card.style.top = (e.clientY - drag.offsetY) + 'px';
    // 挿入位置（この直前に入れるカード。null なら末尾）を求めてプレースホルダを移動
    const beforeId = computeInsertBefore(e);
    const beforeCard = beforeId ? gridEl.querySelector('.pg-card[data-id="' + cssEsc(beforeId) + '"]') : null;
    if (beforeCard) gridEl.insertBefore(placeholder, beforeCard);
    else gridEl.appendChild(placeholder);
  }
  /* いちばん近いカードを探し、その左半分/上半分ならその手前、右半分/下半分なら次の位置に挿入 */
  function computeInsertBefore(e) {
    const cards = [...gridEl.querySelectorAll('.pg-card')].filter(c => c !== drag.card && c !== placeholder);
    if (!cards.length) return null;
    let best = null, bestD = Infinity, before = true;
    for (const c of cards) {
      const r = c.getBoundingClientRect();
      const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      const d = Math.hypot(e.clientX - cx, e.clientY - cy);
      if (d < bestD) {
        bestD = d; best = c;
        before = (Math.abs(e.clientY - cy) < r.height * 0.6) ? (e.clientX < cx) : (e.clientY < cy);
      }
    }
    if (!best) return null;
    const ids = order.filter(id => id !== drag.id);
    const idx = ids.indexOf(best.dataset.id);
    if (before) return best.dataset.id;      // このカードの手前に入れる
    return ids[idx + 1] || null;             // このカードの次（＝末尾なら null）
  }
  /* 浮いていたカードを、挿入枠の位置に戻して見た目を元に戻す */
  function dropCardIntoPlace(card) {
    card.classList.remove('dragging');
    card.style.position = ''; card.style.zIndex = ''; card.style.left = '';
    card.style.top = ''; card.style.width = ''; card.style.pointerEvents = '';
    if (placeholder && placeholder.parentNode === gridEl) {
      try { gridEl.insertBefore(card, placeholder); } catch (e) { /* 一覧が作り直された場合 */ }
      placeholder.remove();
    }
    placeholder = null;
  }
  function endDragCommon() {
    clearTimeout(drag.timer);
    document.removeEventListener('touchmove', blockScroll, { passive: false });
    const d = drag; drag = null; return d;
  }
  async function onDragEnd(e) {
    if (!drag) return;
    const d = endDragCommon();
    if (!d.active) {                          // 長押ししていない＝ふつうのタップ：選択のトグル
      const moved = Math.hypot((e.clientX || 0) - d.startX, (e.clientY || 0) - d.startY);
      if (d.selectable && moved <= MOVE_CANCEL) toggleSelect(d.id);
      return;
    }
    dropCardIntoPlace(d.card);
    // 新しい並びを DOM から取得。変わっていなければ保存しない
    order = [...gridEl.querySelectorAll('.pg-card')].filter(c => !c.classList.contains('pg-placeholder')).map(c => c.dataset.id);
    if (order.join() === d.order0) { render(); return; }
    await PN.editor.reorderPages(order.slice());
    render();
  }
  /* ブラウザがジェスチャを引き取った等でキャンセルされたとき（選択はしない） */
  function onDragCancel() {
    if (!drag) return;
    const d = endDragCommon();
    if (d.active) { dropCardIntoPlace(d.card); render(); }
  }

  function cssEsc(s) { return String(s).replace(/["\\]/g, '\\$&'); }

  return { init, open, close };
})();
