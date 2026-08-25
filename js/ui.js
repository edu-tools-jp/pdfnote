/* PDFノート — 画面の小道具（モーダル・トースト・処理中表示） */
window.PN = window.PN || {};

PN.ui = (function () {
  const $ = (sel, el = document) => el.querySelector(sel);

  /* トースト */
  let toastTimer = null;
  function toast(msg, ms = 2200) {
    const t = $('#toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, ms);
  }

  /* 処理中オーバーレイ */
  function busy(on, text) {
    const b = $('#busy');
    if (text) $('#busy-text').textContent = text;
    b.hidden = !on;
  }

  /* 確認ダイアログ（Promise<boolean>） */
  /* お知らせダイアログ（OKだけ）。notes:[{version,title,items:[]}] */
  function info({ title, notes = [], ok = '閉じる' }) {
    return new Promise((resolve) => {
      const body = notes.map(n => `
        <div class="wn-block">
          <div class="wn-head">${escapeHTML(n.title)}<span class="wn-ver">${escapeHTML(n.version)}</span></div>
          <ul class="wn-list">${(n.items || []).map(t => `<li>${escapeHTML(t)}</li>`).join('')}</ul>
        </div>`).join('');
      const back = document.createElement('div');
      back.className = 'modal-back';
      back.innerHTML = `
        <div class="modal wn-modal">
          <h3>${escapeHTML(title)}</h3>
          <div class="modal-body">${body}</div>
          <div class="modal-foot"><button class="bar-btn primary" data-act="ok">${escapeHTML(ok)}</button></div>
        </div>`;
      document.getElementById('modal-root').appendChild(back);
      const close = () => { back.remove(); resolve(true); };
      back.addEventListener('click', (e) => {
        if (e.target === back || e.target.getAttribute('data-act') === 'ok') close();
      });
      back.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
    });
  }

  function confirm(message, { ok = 'OK', cancel = 'キャンセル', danger = false } = {}) {
    return new Promise((resolve) => {
      const back = document.createElement('div');
      back.className = 'modal-back';
      back.innerHTML = `
        <div class="modal">
          <div class="modal-body"><p style="font-size:17px;line-height:1.7;margin:0">${escapeHTML(message)}</p></div>
          <div class="modal-foot">
            <button class="bar-btn ghost" data-act="cancel">${escapeHTML(cancel)}</button>
            <button class="bar-btn ${danger ? '' : 'primary'}" data-act="ok"
              ${danger ? 'style="background:var(--danger);border-color:var(--danger);color:#fff"' : ''}>${escapeHTML(ok)}</button>
          </div>
        </div>`;
      document.getElementById('modal-root').appendChild(back);
      const close = (v) => { back.remove(); resolve(v); };
      back.addEventListener('click', (e) => {
        if (e.target === back) close(false);
        const act = e.target.getAttribute('data-act');
        if (act === 'ok') close(true);
        if (act === 'cancel') close(false);
      });
    });
  }

  /* 入力フォームのモーダル
   * fields: [{name, label, type:'text'|'select', value, options:[{value,label}], list:[...], placeholder}]
   * 戻り値: 入力値オブジェクト or null（キャンセル） */
  function form({ title, fields, ok = '決定', cancel = 'キャンセル' }) {
    return new Promise((resolve) => {
      const dlId = 'dl-' + Math.random().toString(36).slice(2, 7);
      const rows = fields.map((f) => {
        if (f.type === 'select') {
          const opts = (f.options || []).map(o =>
            `<option value="${escapeAttr(o.value)}" ${o.value === f.value ? 'selected' : ''}>${escapeHTML(o.label)}</option>`).join('');
          return `<label>${escapeHTML(f.label)}<select name="${f.name}">${opts}</select></label>`;
        }
        if (f.type === 'swatch') {
          const sw = (f.options || []).map(o =>
            `<button type="button" class="fc-swatch${o.value === (f.value || '') ? ' active' : ''}"` +
            ` data-val="${escapeAttr(o.value)}" title="${escapeAttr(o.label)}"` +
            ` style="--sw:${escapeAttr(o.color)}"></button>`).join('');
          return `<label>${escapeHTML(f.label)}
            <span class="fc-swatches">${sw}</span>
            <input type="hidden" name="${f.name}" value="${escapeAttr(f.value || '')}"></label>`;
        }
        const listAttr = f.list ? ` list="${dlId}-${f.name}"` : '';
        const datalist = f.list
          ? `<datalist id="${dlId}-${f.name}">${f.list.map(v => `<option value="${escapeAttr(v)}">`).join('')}</datalist>`
          : '';
        return `<label>${escapeHTML(f.label)}
          <input name="${f.name}" type="text" value="${escapeAttr(f.value || '')}"
            placeholder="${escapeAttr(f.placeholder || '')}"${listAttr} autocomplete="off">${datalist}</label>`;
      }).join('');

      const back = document.createElement('div');
      back.className = 'modal-back';
      back.innerHTML = `
        <div class="modal">
          <h3>${escapeHTML(title)}</h3>
          <div class="modal-body">${rows}</div>
          <div class="modal-foot">
            <button class="bar-btn ghost" data-act="cancel">${escapeHTML(cancel)}</button>
            <button class="bar-btn primary" data-act="ok">${escapeHTML(ok)}</button>
          </div>
        </div>`;
      document.getElementById('modal-root').appendChild(back);
      const firstInput = back.querySelector('input:not([type="hidden"]),select');
      if (firstInput) setTimeout(() => firstInput.focus(), 30);

      const close = (val) => { back.remove(); resolve(val); };
      const submit = () => {
        const out = {};
        fields.forEach(f => { out[f.name] = (back.querySelector(`[name="${f.name}"]`).value || '').trim(); });
        close(out);
      };
      back.addEventListener('click', (e) => {
        // 色えらび：押した色を選択状態にして、隠し入力に値を入れる
        const sw = e.target.closest && e.target.closest('.fc-swatch');
        if (sw) {
          const wrap = sw.parentElement;
          wrap.querySelectorAll('.fc-swatch').forEach(b => b.classList.remove('active'));
          sw.classList.add('active');
          const hidden = wrap.parentElement.querySelector('input[type="hidden"]');
          if (hidden) hidden.value = sw.dataset.val;
          return;
        }
        if (e.target === back) close(null);
        const act = e.target.getAttribute('data-act');
        if (act === 'ok') submit();
        if (act === 'cancel') close(null);
      });
      back.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && e.target.tagName === 'INPUT') { e.preventDefault(); submit(); }
        if (e.key === 'Escape') close(null);
      });
    });
  }

  /* 選択ダイアログ（大きなボタンを縦に並べる）。options:[{value,label}] → Promise<value|null> */
  function choose({ title, options, cancel = 'キャンセル' }) {
    return new Promise((resolve) => {
      const back = document.createElement('div');
      back.className = 'modal-back';
      const btns = options.map(o =>
        `<button class="big-btn" data-val="${escapeAttr(o.value)}" style="width:100%;text-align:left">${escapeHTML(o.label)}</button>`).join('');
      back.innerHTML = `
        <div class="modal">
          <h3>${escapeHTML(title)}</h3>
          <div class="modal-body" style="gap:12px">${btns}</div>
          <div class="modal-foot"><button class="bar-btn ghost" data-act="cancel">${escapeHTML(cancel)}</button></div>
        </div>`;
      document.getElementById('modal-root').appendChild(back);
      const close = (v) => { back.remove(); resolve(v); };
      back.addEventListener('click', (e) => {
        if (e.target === back) return close(null);
        const val = e.target.getAttribute('data-val');
        if (val !== null) return close(val);
        if (e.target.getAttribute('data-act') === 'cancel') return close(null);
      });
    });
  }

  /* 小さなポップアップメニュー。items:[{label, danger, onClick}] */
  /* index.html のスプライトからアイコンを取り出す（HTML文字列を返す） */
  function icon(name, cls) {
    return '<svg class="ic' + (cls ? ' ' + cls : '') + '" aria-hidden="true"><use href="#i-' + name + '"/></svg>';
  }

  function menu(anchorEl, items) {
    const back = document.createElement('div');
    back.className = 'modal-back';
    back.style.background = 'transparent';
    back.style.alignItems = 'stretch';
    back.style.justifyContent = 'stretch';
    const box = document.createElement('div');
    box.className = 'modal';
    box.style.position = 'absolute';
    box.style.width = '220px';
    box.style.padding = '8px';
    box.style.display = 'flex';
    box.style.flexDirection = 'column';
    box.style.gap = '4px';
    box.style.maxHeight = 'calc(100vh - 20px)';
    box.style.overflowY = 'auto';
    box.style.visibility = 'hidden';   // 寸法を測るまで隠す
    items.forEach((it) => {
      const b = document.createElement('button');
      b.className = 'bar-btn ghost';
      b.style.textAlign = 'left';
      b.style.justifyContent = 'flex-start';
      if (it.danger) b.style.color = 'var(--danger)';
      if (it.icon) { b.innerHTML = icon(it.icon); b.appendChild(document.createTextNode(it.label)); }
      else b.textContent = it.label;
      b.addEventListener('click', () => { back.remove(); it.onClick(); });
      box.appendChild(b);
    });
    back.appendChild(box);
    back.addEventListener('click', (e) => { if (e.target === back) back.remove(); });
    document.getElementById('modal-root').appendChild(back);

    // 実際の寸法を測ってから、画面内に収まる位置に配置する
    const r = anchorEl.getBoundingClientRect();
    const margin = 10;
    const h = box.offsetHeight, w = box.offsetWidth;
    let top = r.bottom + 6;                          // 基本はアンカーの下
    if (top + h > window.innerHeight - margin) {     // はみ出すなら…
      const above = r.top - 6 - h;                   // アンカーの上に出せるか
      top = (above >= margin) ? above : Math.max(margin, window.innerHeight - margin - h);
    }
    let left = Math.min(r.left, window.innerWidth - w - margin);
    left = Math.max(margin, left);
    box.style.top = top + 'px';
    box.style.left = left + 'px';
    box.style.visibility = '';
  }

  function escapeHTML(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  const escapeAttr = escapeHTML;

  return { toast, busy, confirm, info, form, choose, menu, escapeHTML, icon };
})();
