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
  const DRAG_THRESHOLD = 6;       // これ以上動いたらドラッグ（未満はタップ＝選択）

  function init() {
    root = $('#screen-pages');
    gridEl = $('#pages-grid');
    countEl = $('#pages-count');
    $('#pages-close').addEventListener('click', close);
    $('#pages-selectall').addEventListener('click', toggleSelectAll);
    $('#pages-add').addEventListener('click', () => { close(); PN.app.pickFilesForCurrentNotebook(); });
    $('#pages-delete').addEventListener('click', doDelete);
    $('#pages-copy').addEventListener('click', doCopy);
    $('#pages-export').addEventListener('click', doExport);
    // ドラッグ（並べ替え）
    document.addEventListener('pointermove', onDragMove);
    document.addEventListener('pointerup', onDragEnd);
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
  function close() { root.hidden = true; gridEl.innerHTML = ''; }

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
        <div class="pg-handle" title="ドラッグで並べ替え">⋮⋮</div>
        <div class="pg-check">${selected.has(id) ? '✓' : ''}</div>
        <div class="pg-thumb">${thumbCache[id] ? `<img src="${thumbCache[id]}" alt="" draggable="false">` : '<span>…</span>'}</div>
        <div class="pg-num">${i + 1}</div>`;
      // チェックは常に選択トグル、番号ダブルクリックでそのページを開く
      card.querySelector('.pg-check').addEventListener('click', (e) => { e.stopPropagation(); toggleSelect(id); });
      card.querySelector('.pg-num').addEventListener('dblclick', () => { close(); PN.editor.gotoPageId(id); });
      // サムネ本体：軽くタップ＝選択、ドラッグ＝並べ替え。ハンドルも同じくドラッグ開始
      card.querySelector('.pg-thumb').addEventListener('pointerdown', (e) => onPointerDown(e, id, card, true));
      card.querySelector('.pg-handle').addEventListener('pointerdown', (e) => onPointerDown(e, id, card, false));
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
      card.querySelector('.pg-check').textContent = selected.has(id) ? '✓' : '';
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
    e.preventDefault();
    const r = card.getBoundingClientRect();
    drag = {
      id, card, selectable, pointerId: e.pointerId,
      startX: e.clientX, startY: e.clientY,
      offsetX: e.clientX - r.left, offsetY: e.clientY - r.top,
      w: r.width, h: r.height, active: false
    };
  }
  function activateDrag() {
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
  }
  function onDragMove(e) {
    if (!drag) return;
    if (!drag.active) {
      if (Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) < DRAG_THRESHOLD) return;
      activateDrag();
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
  async function onDragEnd(e) {
    if (!drag) return;
    const d = drag; drag = null;
    if (!d.active) {                          // 動かなかった＝タップ：選択のトグル
      if (d.selectable) toggleSelect(d.id);
      return;
    }
    // 浮いていたカードを、プレースホルダの位置に戻す
    d.card.classList.remove('dragging');
    d.card.style.position = ''; d.card.style.zIndex = ''; d.card.style.left = '';
    d.card.style.top = ''; d.card.style.width = ''; d.card.style.pointerEvents = '';
    if (placeholder && placeholder.parentNode) {
      gridEl.insertBefore(d.card, placeholder);
      placeholder.remove();
    }
    placeholder = null;
    // 新しい並びを DOM から取得して保存
    order = [...gridEl.querySelectorAll('.pg-card')].filter(c => !c.classList.contains('pg-placeholder')).map(c => c.dataset.id);
    await PN.editor.reorderPages(order.slice());
    render();
  }

  function cssEsc(s) { return String(s).replace(/["\\]/g, '\\$&'); }

  return { init, open, close };
})();
