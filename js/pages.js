/* PDFノート — ページ一覧（サムネイル表示・選択・並べ替え・削除/コピー/PDF書き出し） */
window.PN = window.PN || {};

PN.pages = (function () {
  const $ = (s) => document.querySelector(s);

  let root, gridEl, countEl;
  let order = [];                 // 表示順のページID配列
  const selected = new Set();     // 選択中のページID
  const thumbCache = {};          // id -> dataURL
  let drag = null;

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
        <div class="pg-thumb">${thumbCache[id] ? `<img src="${thumbCache[id]}" alt="">` : '<span>…</span>'}</div>
        <div class="pg-num">${i + 1}</div>`;
      // サムネ本体タップ＝選択トグル
      card.querySelector('.pg-thumb').addEventListener('click', () => toggleSelect(id));
      card.querySelector('.pg-check').addEventListener('click', () => toggleSelect(id));
      card.querySelector('.pg-num').addEventListener('dblclick', () => { close(); PN.editor.gotoPageId(id); });
      // 並べ替えハンドル
      const handle = card.querySelector('.pg-handle');
      handle.addEventListener('pointerdown', (e) => onDragStart(e, id, card));
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

  /* ---- ドラッグ並べ替え ---- */
  function onDragStart(e, id, card) {
    e.preventDefault();
    const rect = card.getBoundingClientRect();
    drag = { id, card, offsetX: e.clientX - rect.left, offsetY: e.clientY - rect.top, moved: false, w: rect.width, h: rect.height };
    try { card.setPointerCapture(e.pointerId); } catch (err) {}
  }
  function onDragMove(e) {
    if (!drag) return;
    drag.moved = true;
    drag.card.classList.add('dragging');
    drag.card.style.position = 'fixed';
    drag.card.style.zIndex = '60';
    drag.card.style.width = drag.w + 'px';
    drag.card.style.left = (e.clientX - drag.offsetX) + 'px';
    drag.card.style.top = (e.clientY - drag.offsetY) + 'px';
    drag.card.style.pointerEvents = 'none';
    // 挿入位置を計算：ポインタ直下の他カードの中心と比較
    const cards = [...gridEl.querySelectorAll('.pg-card')].filter(c => c !== drag.card);
    let insertBefore = null;
    for (const c of cards) {
      const r = c.getBoundingClientRect();
      if (e.clientY < r.top + r.height / 2 || (Math.abs(e.clientY - (r.top + r.height / 2)) < r.height / 2 && e.clientX < r.left + r.width / 2)) {
        insertBefore = c; break;
      }
    }
    // プレースホルダ表現：orderを暫定更新して並びを反映
    const targetId = insertBefore ? insertBefore.dataset.id : null;
    reflow(drag.id, targetId);
  }
  function reflow(dragId, beforeId) {
    const cur = order.filter(id => id !== dragId);
    if (beforeId == null) cur.push(dragId);
    else { const i = cur.indexOf(beforeId); cur.splice(i < 0 ? cur.length : i, 0, dragId); }
    if (cur.join() === order.join()) return;
    order = cur;
    // DOMの並びだけ更新（dragカードは fixed のまま、番号振り直し）
    const byId = {};
    gridEl.querySelectorAll('.pg-card').forEach(c => { byId[c.dataset.id] = c; });
    order.forEach((id, i) => {
      const c = byId[id]; if (!c) return;
      gridEl.appendChild(c);
      const num = c.querySelector('.pg-num'); if (num) num.textContent = i + 1;
    });
  }
  async function onDragEnd(e) {
    if (!drag) return;
    const d = drag; drag = null;
    d.card.classList.remove('dragging');
    d.card.style.position = ''; d.card.style.zIndex = ''; d.card.style.left = '';
    d.card.style.top = ''; d.card.style.width = ''; d.card.style.pointerEvents = '';
    if (d.moved) {
      await PN.editor.reorderPages(order.slice());   // 保存＆本体に反映
      render();
    }
  }

  function cssEsc(s) { return String(s).replace(/["\\]/g, '\\$&'); }

  return { init, open, close };
})();
