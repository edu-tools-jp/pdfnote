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
  function info({ title, lead = '', notes = [], ok = '閉じる', cancel = '' }) {
    return new Promise((resolve) => {
      const body = (lead ? `<p class="wn-lead">${escapeHTML(lead)}</p>` : '') + notes.map(n => `
        <div class="wn-block">
          <div class="wn-ver">${escapeHTML(n.version)}</div>
          <div class="wn-head">${escapeHTML(n.title)}</div>
          <ul class="wn-list">${(n.items || []).map(t => `<li>${escapeHTML(t)}</li>`).join('')}</ul>
        </div>`).join('');
      const back = document.createElement('div');
      back.className = 'modal-back';
      back.innerHTML = `
        <div class="modal wn-modal">
          <h3>${escapeHTML(title)}</h3>
          <div class="modal-body">${body}</div>
          <div class="modal-foot">
            ${cancel ? `<button class="bar-btn ghost" data-act="cancel">${escapeHTML(cancel)}</button>` : ''}
            <button class="bar-btn primary" data-act="ok">${escapeHTML(ok)}</button>
          </div>
        </div>`;
      document.getElementById('modal-root').appendChild(back);
      const close = (v) => { back.remove(); resolve(v); };
      back.addEventListener('click', (e) => {
        const act = e.target.getAttribute('data-act');
        if (act === 'ok') close(true);
        else if (act === 'cancel' || e.target === back) close(!cancel);
      });
      back.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(!cancel); });
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
    box.style.width = '270px';
    box.style.padding = '8px';
    box.style.display = 'flex';
    box.style.flexDirection = 'column';
    box.style.gap = '4px';
    box.style.maxHeight = 'calc(100vh - 20px)';
    box.style.overflowY = 'auto';
    box.style.visibility = 'hidden';   // 寸法を測るまで隠す
    items.forEach((it) => {
      const b = document.createElement('button');
      b.className = 'bar-btn ghost menu-item';
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

    placeNear(box, anchorEl);
  }

  /* ---------- ページを追加 ----------
     どこに入れるか（前・後・最後）と、何を入れるか（白紙・画像・写真・PDF）を選ぶ。
     入れる物を押した時点で決まり。{ where, how } を返す（やめたら null）。 */
  function addPage(opts) {
    opts = opts || {};
    return new Promise((resolve) => {
      let where = opts.hasPages ? 'after' : 'end';
      const back = document.createElement('div');
      back.className = 'modal-back';
      const pos = opts.hasPages ? `
        <div class="ap-seg" role="group" aria-label="どこに追加するか">
          <button type="button" data-w="before">前に</button>
          <button type="button" data-w="after" class="on">後に</button>
          <button type="button" data-w="end">最後に</button>
        </div>` : '';
      back.innerHTML = `
        <div class="modal ap-modal">
          <h3>ページを追加</h3>
          ${pos}
          <div class="ap-list">
            <button type="button" class="ap-item" data-how="blank">${icon('note-plus')}<span><b>白紙のページ</b><small>いまのページと同じ大きさ</small></span></button>
            <button type="button" class="ap-item" data-how="image">${icon('image')}<span><b>画像を選ぶ</b><small>写真やスクリーンショットから</small></span></button>
            <button type="button" class="ap-item" data-how="camera">${icon('camera')}<span><b>写真を撮る</b><small>黒板やプリントをその場で</small></span></button>
            <button type="button" class="ap-item" data-how="pdf">${icon('add-page')}<span><b>PDFを読み込む</b><small>配付プリントのPDF</small></span></button>
          </div>
          <div class="modal-foot"><button type="button" class="bar-btn ghost" data-act="cancel">やめる</button></div>
        </div>`;
      const done = (v) => { back.remove(); resolve(v); };
      back.addEventListener('click', (e) => {
        if (e.target === back) return done(null);
        const seg = e.target.closest('.ap-seg button');
        if (seg) {
          where = seg.dataset.w;
          back.querySelectorAll('.ap-seg button').forEach(b => b.classList.toggle('on', b === seg));
          return;
        }
        const item = e.target.closest('.ap-item');
        if (item) return done({ where, how: item.dataset.how });
        if (e.target.closest('[data-act="cancel"]')) return done(null);
      });
      document.getElementById('modal-root').appendChild(back);
    });
  }

  /* ---------- 色えらび（プリセット／カスタム） ----------
     色のボタンをもう一度押したときに開く。選ぶとその場で色が変わる。 */
  const CP_PRESET = [
    '#1a1a1a', '#4d4d4d', '#909090', '#d0d0d0', '#ffffff', '#8e44ad', '#e0301e', '#e2574c',
    '#f08ca0', '#f0a500', '#1e6fe0', '#1b4f8a', '#15a05a', '#7cb342', '#f2e14c', '#6ec6f0',
    '#8d5a3b', '#0f7a5a', '#5fd6a8', '#7986cb', '#d81b60', '#e8590c', '#f5c518', '#ffe9a8'
  ];
  /* カスタム用の色みの表。左の1列は白黒、そのあとは色あい × 明るさ */
  function customGrid() {
    const cols = 11, rows = 9, out = [];
    for (let r = 0; r < rows; r++) {
      const l = 12 + r * 10;                       // 明るさ 12%〜92%
      for (let c = 0; c < cols; c++) {
        if (c === 0) out.push(hsl(0, 0, l));
        else out.push(hsl(Math.round((c - 1) * (360 / (cols - 1))), 85, l));
      }
    }
    return out;
  }
  function hsl(h, s, l) {
    const a = s / 100 * Math.min(l / 100, 1 - l / 100);
    const f = (n) => {
      const k = (n + h / 30) % 12;
      const v = l / 100 - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
      return Math.round(255 * v).toString(16).padStart(2, '0');
    };
    return '#' + f(0) + f(8) + f(4);
  }

  function colorPicker(anchorEl, current, onPick, opts) {
    opts = opts || {};
    const back = document.createElement('div');
    back.className = 'modal-back';
    back.style.background = 'transparent';
    back.style.alignItems = 'stretch';
    back.style.justifyContent = 'stretch';
    const box = document.createElement('div');
    box.className = 'modal cp';
    box.style.position = 'absolute';
    box.style.visibility = 'hidden';
    box.innerHTML =
      '<div class="cp-head">色をえらぶ</div>' +
      '<div class="cp-tabs">' +
        '<button type="button" class="on" data-tab="preset">プリセット</button>' +
        '<button type="button" data-tab="custom">カスタム</button>' +
      '</div>' +
      '<div class="cp-grid preset" data-pane="preset"></div>' +
      '<div class="cp-grid custom" data-pane="custom" hidden></div>' +
      '<div class="cp-foot">' +
        '<input type="color" class="cp-native" title="もっと細かく選ぶ">' +
        '<input type="text" class="cp-hex" maxlength="7" spellcheck="false" title="色の番号（例 #e0301e）">' +
        (opts.onReset ? '<button type="button" class="bar-btn ghost cp-reset">もとにもどす</button>' : '') +
      '</div>';

    const close = () => back.remove();
    const pick = (c) => { close(); onPick(c); };

    const fill = (host, list) => {
      host.innerHTML = '';
      list.forEach(c => {
        const cell = document.createElement('span');
        cell.className = 'cp-cell' + (c.toLowerCase() === String(current).toLowerCase() ? ' on' : '');
        cell.style.background = c;
        cell.title = c;
        cell.addEventListener('click', () => pick(c));
        host.appendChild(cell);
      });
    };
    fill(box.querySelector('[data-pane="preset"]'), CP_PRESET);
    fill(box.querySelector('[data-pane="custom"]'), customGrid());

    box.querySelectorAll('.cp-tabs button').forEach(t => {
      t.addEventListener('click', () => {
        box.querySelectorAll('.cp-tabs button').forEach(x => x.classList.toggle('on', x === t));
        box.querySelectorAll('[data-pane]').forEach(pane => { pane.hidden = pane.dataset.pane !== t.dataset.tab; });
      });
    });

    const native = box.querySelector('.cp-native');
    const hex = box.querySelector('.cp-hex');
    native.value = normHex(current) || '#000000';
    hex.value = normHex(current) || '';
    native.addEventListener('change', () => pick(native.value));
    const applyHex = () => { const v = normHex(hex.value); if (v) pick(v); };
    hex.addEventListener('change', applyHex);
    hex.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); applyHex(); } });
    const reset = box.querySelector('.cp-reset');
    if (reset) reset.addEventListener('click', () => { close(); opts.onReset(); });

    back.appendChild(box);
    back.addEventListener('click', (e) => { if (e.target === back) close(); });
    document.getElementById('modal-root').appendChild(back);
    placeNear(box, anchorEl);
  }
  /* ---------- 太さえらび ----------
     いま選んでいる太さのボタンをもう一度押したときに開く。
     つまみを動かすとその場で太さが変わる（閉じるまで何度でも試せる）。 */
  function widthPicker(anchorEl, mm, opts) {
    opts = opts || {};
    const min = opts.min != null ? opts.min : 0.1;
    const max = opts.max != null ? opts.max : 2.0;
    const step = opts.step || 0.05;
    const back = document.createElement('div');
    back.className = 'modal-back';
    back.style.background = 'transparent';
    back.style.alignItems = 'stretch';
    back.style.justifyContent = 'stretch';
    const box = document.createElement('div');
    box.className = 'modal wp';
    box.style.position = 'absolute';
    box.style.visibility = 'hidden';
    box.innerHTML =
      '<div class="wp-head">ペンの太さ</div>' +
      '<div class="wp-preview"><span class="wp-line"></span></div>' +
      '<div class="wp-row">' +
        '<span class="wp-val"></span>' +
        '<input type="range" class="wp-range">' +
      '</div>' +
      '<div class="wp-scale"><span>' + fmtMm(min) + '</span><span>' + fmtMm(max) + '</span></div>' +
      (opts.onReset ? '<div class="wp-foot"><button type="button" class="bar-btn ghost wp-reset">もとにもどす</button></div>' : '');

    const range = box.querySelector('.wp-range');
    const val = box.querySelector('.wp-val');
    const line = box.querySelector('.wp-line');
    range.min = min; range.max = max; range.step = step;
    range.value = Math.min(max, Math.max(min, mm));
    const show = (v) => {
      val.textContent = fmtMm(v) + ' mm';
      line.style.height = Math.max(1, v * 6.2) + 'px';   // 画面上のA4はおよそ6.2px/mm
    };
    show(+range.value);
    range.addEventListener('input', () => { show(+range.value); if (opts.onChange) opts.onChange(+range.value); });

    const reset = box.querySelector('.wp-reset');
    if (reset) reset.addEventListener('click', () => { back.remove(); opts.onReset(); });

    back.appendChild(box);
    back.addEventListener('click', (e) => { if (e.target === back) back.remove(); });
    document.getElementById('modal-root').appendChild(back);
    placeNear(box, anchorEl);
  }
  /* 0.5 → "0.5"、1.25 → "1.25"、2 → "2.0" */
  function fmtMm(v) {
    const n = Math.round(v * 100) / 100;
    return n.toFixed((Math.round(n * 100) % 10 === 0) ? 1 : 2);
  }

  /* #rgb / #rrggbb / rrggbb を #rrggbb にそろえる。だめなら null */
  function normHex(v) {
    const m = String(v || '').trim().replace(/^#/, '');
    if (/^[0-9a-fA-F]{3}$/.test(m)) return '#' + m.split('').map(c => c + c).join('').toLowerCase();
    if (/^[0-9a-fA-F]{6}$/.test(m)) return '#' + m.toLowerCase();
    return null;
  }

  /* 実際の寸法を測ってから、画面内に収まる位置に置く */
  function placeNear(box, anchorEl) {
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

  return { toast, busy, confirm, info, form, choose, menu, addPage, colorPicker, widthPicker, escapeHTML, icon };
})();
